local base64 = require("strudel.base64")

local M = {}

local log = require("strudel.log")

local MESSAGES = {
  CONTENT = "STRUDEL_CONTENT:",
  QUIT = "STRUDEL_QUIT",
  TOGGLE = "STRUDEL_TOGGLE",
  UPDATE = "STRUDEL_UPDATE",
  STOP = "STRUDEL_STOP",
  REFRESH = "STRUDEL_REFRESH",
  READY = "STRUDEL_READY",
  CURSOR = "STRUDEL_CURSOR:",
  EVAL_ERROR = "STRUDEL_EVAL_ERROR:",
  SAMPLES = "STRUDEL_SAMPLES:"
}

local STRUDEL_SYNC_AUTOCOMMAND = "StrudelSync"
local SUCCESSIVE_CMD_DELAY = 50

-- State
local strudel_job_id = nil
local last_content = nil
local strudel_synced_bufnr = nil
local strudel_ready = false
local custom_css_b64 = nil
local last_received_cursor = nil -- {row, col}
local lsp_client_id = nil
local doc_json_path = vim.fn.stdpath("cache") .. "/strudel-nvim/doc.json"
local docgen_job_id = nil
local docgen_running = false
local docgen_failed = nil
local docgen_failed_at = nil
local docgen_retry_timer = nil
local pending_lsp_bufs = {}

local cancel_active_job

-- Event queue for sequential message processing
local event_queue = {}
local is_processing_event = false

local stored_samples = nil
-- Config with default options
local config = {
  ui = {
    maximise_menu_panel = true,
    hide_menu_panel = false,
    hide_top_bar = false,
    hide_code_editor = false,
    hide_error_display = false,
    custom_css_file = nil,
  },
  lsp = {
    enabled = true,
  },
  report_eval_errors = true,
  sync_cursor = true,
  start_on_launch = true,
  update_on_save = false,
  headless = false,
  browser_data_dir = nil,
  browser_exec_path = nil,
  browser_remote_debug_port = 9222,
  local_server = {
    repo_url = "https://codeberg.org/uzu/strudel.git",
    repo_dir = vim.fn.stdpath("cache") .. "/strudel-nvim/strudel-src"
  },
  local_samples = {
    enabled = false,
    preferred_dirs = { ".samples", "samples", ".sounds", "sounds" },
    port = 0,
  },
}

local local_samples_job_id = nil
local local_samples_manifest_url = nil
local local_samples_pending_import = false

local function find_first_dir(candidates)
  for _, p in ipairs(candidates) do
    if type(p) == "string" and p ~= "" and vim.fn.isdirectory(p) == 1 then
      return p
    end
  end
  return nil
end

local function stop_local_samples_server()
  if local_samples_job_id then
    pcall(vim.fn.jobstop, local_samples_job_id)
  end
  local_samples_job_id = nil
  local_samples_manifest_url = nil
  local_samples_pending_import = false
end

local function start_local_samples_server(plugin_root)
  stop_local_samples_server()

  if not config.local_samples or not config.local_samples.enabled then
    return
  end

  local cwd = vim.fn.getcwd()
  local preferred = config.local_samples.preferred_dirs or { ".samples", "samples", ".sounds", "sounds" }
  local candidates = {}
  for _, name in ipairs(preferred) do
    table.insert(candidates, cwd .. "/" .. name)
  end

  local root_dir = find_first_dir(candidates)
  if not root_dir then
    return
  end

  local script = plugin_root .. "/js/local_samples_server.js"
  local args = {
    "node",
    script,
    "--root=" .. root_dir,
    "--port=" .. tostring(config.local_samples.port or 0),
  }

  local function on_stdout(_, data)
    if not data then
      return
    end

    for _, line in ipairs(data) do
      if type(line) == "string" and line:match("^STRUDEL_LOCAL_SAMPLES_READY:") then
        local b64 = line:sub(#"STRUDEL_LOCAL_SAMPLES_READY:" + 1)
        local ok, decoded = pcall(base64.decode, b64)
        if not ok then
          log.warn("Strudel local samples: failed to decode READY")
          return
        end

        local ok2, payload = pcall(vim.json.decode, decoded)
        if not ok2 or type(payload) ~= "table" then
          log.warn("Strudel local samples: invalid READY payload")
          return
        end

        if type(payload.manifestUrl) == "string" then
          local_samples_manifest_url = payload.manifestUrl

          if strudel_job_id and local_samples_pending_import then
            local payload2 = { manifestUrl = local_samples_manifest_url }
            local b642 = base64.encode(vim.json.encode(payload2))
            send_message("STRUDEL_IMPORT_LOCAL_SAMPLES:" .. b642)
            local_samples_pending_import = false
          end
        end
      elseif type(line) == "string" and line:match("^STRUDEL_LOCAL_SAMPLES_ERROR:") then
        local b64 = line:sub(#"STRUDEL_LOCAL_SAMPLES_ERROR:" + 1)
        local ok, decoded = pcall(base64.decode, b64)
        if ok then
          log.warn("Strudel local samples error: " .. decoded)
        else
          log.warn("Strudel local samples error")
        end
      end
    end
  end

  local_samples_job_id = vim.fn.jobstart(args, {
    on_stdout = on_stdout,
    on_stderr = on_stdout,
  })
end

local function send_message(message)
  if strudel_job_id then
    vim.fn.chansend(strudel_job_id, message .. "\n")
  else
    log.warn("No active Strudel session")
  end
end
local function set_samples(samples)
  stored_samples = samples
end

function M.import_local_samples()
  if not strudel_job_id then
    log.warn("No active Strudel session")
    return
  end

  if local_samples_manifest_url then
    local payload = { manifestUrl = local_samples_manifest_url }
    local b64 = base64.encode(vim.json.encode(payload))
    send_message("STRUDEL_IMPORT_LOCAL_SAMPLES:" .. b64)
    return
  end

  if local_samples_job_id then
    local_samples_pending_import = true
    log.info("Strudel local samples: waiting for server...")
  else
    log.info("Strudel local samples: no samples folder detected")
  end
end

local function notify_lsp_samples(samples)
  if not samples then
    return
  end

  for _, c in pairs(vim.lsp.get_clients({ name = "strudel" })) do
    pcall(function()
      c.notify("strudel/samples", samples)
    end)
  end
end

local start_or_attach_lsp

local function doc_json_file_ready()
  if not doc_json_path or doc_json_path == "" then
    return false
  end

  local stat = (vim.uv or vim.loop).fs_stat(doc_json_path)
  return stat and stat.type == "file" and stat.size and stat.size > 0
end

local function doc_json_valid()
  if not doc_json_file_ready() then
    return false
  end

  local ok, lines = pcall(vim.fn.readfile, doc_json_path)
  if not ok or type(lines) ~= "table" then
    return false
  end

  local raw = table.concat(lines, "\n")
  local ok2, decoded = pcall(vim.json.decode, raw)
  if not ok2 or type(decoded) ~= "table" then
    return false
  end

  return type(decoded.docs) == "table"
end

local function attach_pending_lsp_bufs()
  if not doc_json_valid() then
    return
  end

  for bufnr, _ in pairs(pending_lsp_bufs) do
    if vim.api.nvim_buf_is_valid(bufnr) then
      start_or_attach_lsp(bufnr)
    end
    pending_lsp_bufs[bufnr] = nil
  end
end

local function start_docgen(plugin_root)
  if docgen_running then
    return
  end

  -- Auto-retry is allowed, but avoid as-fast-as-possible respawn loops.
  if docgen_failed_at and (os.time() - docgen_failed_at) < 30 then
    if not docgen_retry_timer then
      vim.schedule(function()
        log.info("doc.json generation recently failed; retrying soon")
      end)
      docgen_retry_timer = vim.defer_fn(function()
        docgen_retry_timer = nil
        if doc_json_valid() then
          attach_pending_lsp_bufs()
          return
        end
        start_docgen(plugin_root)
      end, 30 * 1000)
    end
    return
  end

  docgen_running = true
  docgen_failed = nil
  docgen_failed_at = nil

  if docgen_retry_timer then
    pcall(function()
      docgen_retry_timer:stop()
      docgen_retry_timer:close()
    end)
    docgen_retry_timer = nil
  end

  local script = plugin_root .. "/js/launch.js"

  if not doc_json_path or doc_json_path == "" then
    doc_json_path = vim.fn.stdpath("cache") .. "/strudel-nvim/doc.json"
  end

  local args = {
    "node",
    script,
    "--doc-json-out=" .. doc_json_path,
    "--doc-only",
  }

  table.insert(args, "--local-server")
  table.insert(args, "--repo-url=" .. config.local_server.repo_url)
  table.insert(args, "--repo-dir=" .. config.local_server.repo_dir)

  vim.schedule(function()
    log.reset_run({ title = "Strudel: generate docs", status = "running", focus = true })
    log.output({ "starting...", "" })
  end)

  local collected_err = {}

  local function collect_lines(data)
    if not data then
      return
    end

    local printable = {}
    for _, line in ipairs(data) do
      if type(line) == "string" and line ~= "" then
        table.insert(printable, line)
        table.insert(collected_err, line)
        if #collected_err > 40 then
          table.remove(collected_err, 1)
        end
      end
    end

    if #printable > 0 then
      vim.schedule(function()
        log.output(printable)
      end)
    end
  end

  docgen_job_id = vim.fn.jobstart(args, {
    stdout_buffered = false,
    stderr_buffered = false,
    on_stdout = function(_, data)
      collect_lines(data)
    end,
    on_stderr = function(_, data)
      collect_lines(data)
    end,
    on_exit = function(_, code)
      docgen_job_id = nil
      docgen_running = false

      vim.schedule(function()
        log.attach_job(nil)
      end)

      if code == 0 then
        local attempts_left = 10
        local function try_attach()
          if doc_json_file_ready() then
            vim.schedule(function()
               log.output({ "", "doc.json ready; starting LSP" })
               log.attach_job(nil)
            end)
            attach_pending_lsp_bufs()
            return
          end

          attempts_left = attempts_left - 1
          if attempts_left <= 0 then
            docgen_failed = "doc.json generation failed"
            docgen_failed_at = os.time()
            local tail = table.concat(collected_err, "\n")
            vim.schedule(function()
              log.output({ "", "doc.json generation finished but file not ready", "" })
              if tail ~= "" then
                log.output({ "--- tail ---", tail })
              end
              log.error("doc.json generation finished but file not ready", { notify = true })
            end)
            return
          end

          vim.defer_fn(try_attach, 100)
        end

        try_attach()
        return
      end

      docgen_failed = "doc.json generation failed"
      docgen_failed_at = os.time()
      local tail = table.concat(collected_err, "\n")
      vim.schedule(function()
        log.output({ "", "doc.json generation failed", "" })
        if tail ~= "" then
          log.output({ "--- tail ---", tail })
        end
        log.error("doc.json generation failed", { notify = true })
      end)
    end,
  })

  vim.schedule(function()
    log.attach_job(docgen_job_id)
  end)

  if type(docgen_job_id) ~= "number" or docgen_job_id <= 0 then
    docgen_job_id = nil
    docgen_running = false
    docgen_failed = "jobstart failed"
    docgen_failed_at = os.time()
    vim.schedule(function()
      log.error("failed to start doc generation job", { notify = true })
    end)
  end
end

local function ensure_doc_json_then_start_lsp(bufnr)
  pending_lsp_bufs[bufnr] = true

  if doc_json_valid() then
    log.info("doc.json found; starting LSP")
    attach_pending_lsp_bufs()
    return
  end

  if docgen_failed then
    -- Auto-retry on subsequent opens per user preference.
    -- Backoff is handled in start_docgen().
    docgen_failed = nil
  end

  local plugin_root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h:h")
  start_docgen(plugin_root)
end

start_or_attach_lsp = function(bufnr)
  if not config.lsp.enabled then
    return
  end

  if not doc_json_valid() then
    return
  end

  -- Start once, then attach to any ft=strudel buffer.
  if lsp_client_id then
    local client = vim.lsp.get_client_by_id(lsp_client_id)
    if not client then
      lsp_client_id = nil
    end
  end

  if lsp_client_id then
    local already = vim.lsp.get_clients({ bufnr = bufnr, name = "strudel" })
    if #already == 0 then
      pcall(vim.lsp.buf_attach_client, bufnr, lsp_client_id)
      log.info("LSP attached")
    end
    return
  end

  local plugin_root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h:h")
  local server = plugin_root .. "/dist/lsp/server.js"

  local cmd = {
    "node",
    server,
    "--stdio",
    "--doc-json-path",
    doc_json_path,
  }

  log.info("LSP starting...")
   local ok, client_id_or_err = pcall(vim.lsp.start, {
     name = "strudel",
     cmd = cmd,
    root_dir = plugin_root,
     bufnr = bufnr,
     handlers = {
       ["textDocument/completion"] = function(err, result, ctx, config_)
         local n = 0
         if type(result) == "table" then
           if type(result.items) == "table" then
             n = #result.items
           elseif vim.tbl_islist(result) then
             n = #result
           end
         end
         log.output(string.format("[lsp] completion response: err=%s items=%d", tostring(err ~= nil), n))
         return vim.lsp.handlers["textDocument/completion"](err, result, ctx, config_)
       end,
     },
     on_attach = function(client, attached_bufnr)
       if client.rpc and client.rpc.stderr and type(client.rpc.stderr.read_start) == "function" then
         client.rpc.stderr:read_start(function(err, chunk)
           if err then
             log.warn("LSP stderr read error: " .. tostring(err), { notify = false })
             return
           end
           if not chunk or chunk == "" then
             return
           end
           for _, line in ipairs(vim.split(chunk, "\n", { plain = true, trimempty = true })) do
             log.output("[lsp] " .. line)
           end
         end)
       end

       -- LSP-side code actions can invoke custom commands; handle them here.
       client.commands = client.commands or {}
       client.commands["strudel.extractLet"] = function(command, ctx)
        local args = (command and command.arguments and command.arguments[1]) or {}
        local uri = args.uri
        local range = args.range
        local target_bufnr = attached_bufnr

        if type(uri) == "string" and uri ~= "" then
          local maybe = vim.uri_to_bufnr(uri)
          if type(maybe) == "number" and maybe > 0 then
            target_bufnr = maybe
          end
        end

        if not (range and range.start and range["end"]) then
          log.warn("extractLet: missing range")
          return
        end

        local start = range.start
        local finish = range["end"]
        local srow = (start.line or 0)
        local scol = (start.character or 0)
        local erow = (finish.line or 0)
        local ecol = (finish.character or 0)

        if srow > erow or (srow == erow and scol > ecol) then
          -- Normalize reversed ranges.
          srow, erow = erow, srow
          scol, ecol = ecol, scol
        end

        local lines = vim.api.nvim_buf_get_lines(target_bufnr, srow, erow + 1, false)
        if #lines == 0 then
          return
        end

        local selected = ""
        if srow == erow then
          local line = lines[1] or ""
          selected = line:sub(scol + 1, ecol)
        else
          local first = lines[1] or ""
          local last = lines[#lines] or ""

          local parts = {}
          parts[1] = first:sub(scol + 1)
          for i = 2, #lines - 1 do
            parts[#parts + 1] = lines[i] or ""
          end
          parts[#parts + 1] = last:sub(1, ecol)

          selected = table.concat(parts, "\n")
        end

        if selected == "" then
          return
        end

        vim.ui.input({ prompt = "Extract to let: name" }, function(name)
          if not name or name == "" then
            return
          end

          if not name:match("^[%a_$][%w_$]*$") then
            log.warn("invalid variable name: " .. tostring(name))
            return
          end

          local first_line = vim.api.nvim_buf_get_lines(target_bufnr, srow, srow + 1, false)[1] or ""
          local indent = first_line:match("^%s*") or ""

          local decl_lines = {}
          if selected:find("\n") then
            decl_lines[1] = "let " .. name .. " = ("
            for _, l in ipairs(vim.split(selected, "\n", { plain = true })) do
              decl_lines[#decl_lines + 1] = indent .. l
            end
            decl_lines[#decl_lines + 1] = ")"
          else
            decl_lines[1] = "let " .. name .. " = " .. selected
          end

          -- Replace selection with variable name, then insert declaration at top.
          if srow == erow then
            local repl_line = vim.api.nvim_buf_get_lines(target_bufnr, srow, srow + 1, false)[1] or ""
            local before = repl_line:sub(1, scol)
            local after = repl_line:sub(ecol + 1)
            local new_line = before .. name .. after
            vim.api.nvim_buf_set_lines(target_bufnr, srow, srow + 1, false, { new_line })
          else
            local first = lines[1] or ""
            local last = lines[#lines] or ""
            local before = first:sub(1, scol)
            local after = last:sub(ecol + 1)
            local new_line = before .. name .. after
            vim.api.nvim_buf_set_lines(target_bufnr, srow, erow + 1, false, { new_line })
          end

          vim.api.nvim_buf_set_lines(target_bufnr, 0, 0, false, vim.list_extend(decl_lines, { "" }))
        end)
      end
    end,
  })

  if not ok then
      vim.schedule(function()
        log.reset_run({ title = "Strudel: LSP", status = "failed", focus = true })
        log.error("failed to start LSP: " .. tostring(client_id_or_err), { notify = true })
      end)
    return
  end

  if type(client_id_or_err) ~= "number" then
    vim.schedule(function()
      log.reset_run({ title = "Strudel: LSP", status = "failed", focus = true })
      log.error("failed to start LSP (no client id returned)", { notify = true })
    end)
    return
  end

  lsp_client_id = client_id_or_err
  log.info("LSP started (client id=" .. tostring(lsp_client_id) .. ")")

  -- If we already received samples before LSP started, replay them.
  notify_lsp_samples(stored_samples)
end

local function send_cursor_position()
  if not strudel_job_id or not strudel_synced_bufnr or not strudel_ready or not config.sync_cursor then
    return
  end
  if not vim.api.nvim_buf_is_valid(strudel_synced_bufnr) then
    return
  end

  local pos = vim.api.nvim_win_get_cursor(0)
  local row, col = pos[1], pos[2]
  if last_received_cursor and last_received_cursor[1] == row and last_received_cursor[2] == col then
    return
  end
  send_message(MESSAGES.CURSOR .. row .. ":" .. col)
end

local function send_buffer_content()
  if not strudel_job_id or not strudel_synced_bufnr or not strudel_ready then
    return
  end
  if not vim.api.nvim_buf_is_valid(strudel_synced_bufnr) then
    return
  end

  local lines = vim.api.nvim_buf_get_lines(strudel_synced_bufnr, 0, -1, false)
  local content = table.concat(lines, "\n")
  local base64_content = base64.encode(content)

  if base64_content ~= last_content then
    last_content = base64_content
    send_message(MESSAGES.CONTENT .. base64_content)
    vim.defer_fn(function()
      send_cursor_position()
    end, SUCCESSIVE_CMD_DELAY)
  end
end

local function set_buffer_content(bufnr, content)
  local lines = {}
  if content ~= "" then
    lines = vim.split(content, "\n")
  end

  vim.schedule(function()
    if not vim.api.nvim_buf_is_valid(bufnr) then
      return
    end

    -- Save current window view (persist cursor location across content update)
    local view = vim.fn.winsaveview()
    -- Update buffer content
    vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
    -- Restore window view
    vim.fn.winrestview(view)
  end)
end

local function handle_event(full_data)
  if full_data:match("^" .. MESSAGES.READY) then
    strudel_ready = true

    if local_samples_manifest_url then
      local payload = { manifestUrl = local_samples_manifest_url }
      local b64 = base64.encode(vim.json.encode(payload))
      send_message("STRUDEL_IMPORT_LOCAL_SAMPLES:" .. b64)
    elseif local_samples_job_id then
      local_samples_pending_import = true
    end

      if strudel_synced_bufnr then
        ensure_doc_json_then_start_lsp(strudel_synced_bufnr)
        send_buffer_content()

       if config.start_on_launch then
         vim.defer_fn(function()
           M.update()
         end, SUCCESSIVE_CMD_DELAY * 2)
       end
     end

  elseif full_data:match("^" .. MESSAGES.CONTENT) then
    local content_b64 = full_data:sub(#MESSAGES.CONTENT + 1)
    if content_b64 == last_content then
      return
    end
    last_content = content_b64
    if strudel_synced_bufnr and vim.api.nvim_buf_is_valid(strudel_synced_bufnr) then
      local content = base64.decode(content_b64)
      set_buffer_content(strudel_synced_bufnr, content)
    end
  elseif full_data:match("^" .. MESSAGES.CURSOR) and config.sync_cursor then
    local cursor_str = full_data:sub(#MESSAGES.CURSOR + 1)
    local row, col = cursor_str:match("^(%d+):(%d+)$")
    row, col = tonumber(row), tonumber(col)
    if row and col and strudel_synced_bufnr and vim.api.nvim_buf_is_valid(strudel_synced_bufnr) then
      vim.schedule(function()
        local line_count = vim.api.nvim_buf_line_count(strudel_synced_bufnr)
        local clamped_row = math.max(1, math.min(row, line_count))
        local line = vim.api.nvim_buf_get_lines(strudel_synced_bufnr, clamped_row - 1, clamped_row, false)[1] or ""
        local clamped_col = math.max(0, math.min(col, #line))
        last_received_cursor = { clamped_row, clamped_col }
        vim.api.nvim_win_set_cursor(0, { clamped_row, clamped_col })
      end)
    end
  elseif full_data:match("^" .. MESSAGES.SAMPLES) then
    local samples_b64 = full_data:sub(#MESSAGES.SAMPLES + 1)
    local decoded = base64.decode(samples_b64)
    local ok, samples = pcall(vim.json.decode, decoded)
    if ok and type(samples) == "table" then
      set_samples(samples)
      notify_lsp_samples(samples)
    end
  elseif full_data:match("^STRUDEL_IMPORT_LOCAL_SAMPLES_OK:") then
    local b64 = full_data:sub(#"STRUDEL_IMPORT_LOCAL_SAMPLES_OK:" + 1)
    local decoded = base64.decode(b64)
    local ok, payload = pcall(vim.json.decode, decoded)

     vim.schedule(function()
       if ok and type(payload) == "table" and type(payload.importedKeys) == "table" then
         log.info(
           string.format(
             "Strudel local samples: imported %d sounds (soundMap now %s)",
             #payload.importedKeys,
             tostring(payload.soundCountAfter or "?"))
         )
       else
         log.info("Strudel local samples: imported")
       end
     end)

  elseif full_data:match("^STRUDEL_IMPORT_LOCAL_SAMPLES_ERROR:") then
    local b64 = full_data:sub(#"STRUDEL_IMPORT_LOCAL_SAMPLES_ERROR:" + 1)
    local decoded = base64.decode(b64)
    vim.schedule(function()
      log.warn("Strudel local samples import failed: " .. decoded)
    end)
  elseif full_data:match("^" .. MESSAGES.EVAL_ERROR) then
    local error_b64 = full_data:sub(#MESSAGES.EVAL_ERROR + 1)
    local error = base64.decode(error_b64)
    if config.report_eval_errors then
      vim.schedule(function()
        log.error("Strudel Error: " .. error)
      end)
    end
  end
end

local function process_event_queue()
  if is_processing_event then
    return
  end

  is_processing_event = true

  vim.schedule(function()
    while #event_queue > 0 do
      local message = table.remove(event_queue, 1)
      handle_event(message)
    end

    is_processing_event = false
  end)
end

-- Public API
function M.setup(opts)
  opts = opts or {}
  config = vim.tbl_deep_extend("force", config, opts)

  -- Load custom CSS content and base64 encode it
  local css_path = config.custom_css_file
  if css_path then
    local f = io.open(css_path, "rb")
    if f then
      local css = f:read("*a")
      f:close()
      custom_css_b64 = base64.encode(css)
    else
      log.error("Could not read custom CSS file: " .. css_path)
    end
  end

  -- Doc path is stable and decoupled from session launch.

  -- Create autocmd group
  vim.api.nvim_create_augroup(STRUDEL_SYNC_AUTOCOMMAND, { clear = true })

  local function is_strudel_buf(bufnr)
    local name = vim.api.nvim_buf_get_name(bufnr)
    return name:match("%.str$") or name:match("%.std$")
  end

  -- .str/.std use a dedicated ft so JS/TS LSPs don't auto-attach.
  vim.api.nvim_create_autocmd({ "BufRead", "BufNewFile" }, {
    pattern = { "*.str", "*.std" },
    callback = function(ev)
      vim.bo[ev.buf].filetype = "strudel"

      if strudel_job_id == nil then
        vim.schedule(function()
          log.hint_once("no_session", "Strudel session not running. Use :StrudelLaunch")
        end)
      end
    end,
  })


   -- Provide JavaScript syntax highlighting while keeping ft=strudel.
   vim.api.nvim_create_autocmd("FileType", {
     group = STRUDEL_SYNC_AUTOCOMMAND,
     pattern = "strudel",
       callback = function(ev)
        ensure_doc_json_then_start_lsp(ev.buf)

        -- Enable comment plugins (gc) by providing a JS-style commentstring.
        -- Keep ft=strudel so other JS/TS LSPs don't auto-attach.
        vim.bo[ev.buf].commentstring = "// %s"


        -- Defer so we run after Neovim's default `:syntax on` machinery
        -- (which otherwise resets `&l:syntax` back to the filetype).
        vim.defer_fn(function()
          if not vim.api.nvim_buf_is_valid(ev.buf) then
            return
          end
          vim.b[ev.buf].current_syntax = nil
          vim.cmd("setlocal syntax=javascript")
        end, 0)
      end,
    })


  -- Prevent unrelated LSPs from attaching and reporting bogus diagnostics.
  vim.api.nvim_create_autocmd("LspAttach", {
    group = STRUDEL_SYNC_AUTOCOMMAND,
    callback = function(ev)
      if not is_strudel_buf(ev.buf) then
        return
      end

      local client = vim.lsp.get_client_by_id(ev.data.client_id)
      if not client then
        return
      end

      -- Only the Strudel LSP should stay attached.
      -- Detach other clients after LspAttach finishes to avoid a
      -- Neovim 0.11 change-tracking race.
      if client.name ~= "strudel" then
        vim.defer_fn(function()
          if vim.api.nvim_buf_is_valid(ev.buf) then
            pcall(vim.lsp.buf_detach_client, ev.buf, client.id)
          end
        end, 0)
        return
      end
    end,
  })

  -- Commands
  vim.api.nvim_create_user_command("StrudelLaunch", M.launch, {})
  vim.api.nvim_create_user_command("StrudelQuit", M.quit, {})
  vim.api.nvim_create_user_command("StrudelToggle", M.toggle, {})
  vim.api.nvim_create_user_command("StrudelUpdate", M.update, {})
  vim.api.nvim_create_user_command("StrudelStop", M.stop, {})
  vim.api.nvim_create_user_command("StrudelSetBuffer", M.set_buffer, { nargs = "?" })
  vim.api.nvim_create_user_command("StrudelExecute", M.execute, {})
  vim.api.nvim_create_user_command("StrudelImportLocalSamples", M.import_local_samples, {})


  vim.api.nvim_create_user_command("StrudelGenerateDocs", function()
    local plugin_root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h:h")
    start_docgen(plugin_root)
  end, { desc = "Generate doc.json used by Strudel LSP" })

  vim.api.nvim_create_user_command("StrudelLogs", function()
    log.open(true)
  end, { desc = "Open Strudel log window" })

  vim.api.nvim_create_user_command("StrudelCancel", function()
    cancel_active_job()
  end, { desc = "Cancel running Strudel job" })
end

cancel_active_job = function()
  if docgen_job_id and docgen_job_id > 0 then
    log.reset_run({ title = "Strudel: generate docs", status = "running", focus = true })
    log.attach_job(docgen_job_id)
    log.cancel()
    return
  end

  if strudel_job_id and strudel_job_id > 0 then
    log.reset_run({ title = "Strudel: launch", status = "running", focus = true })
    log.attach_job(strudel_job_id)
    log.cancel()
  end
end

function M.launch()
  if strudel_job_id ~= nil then
    log.open(true)
    log.warn("Strudel is already running, run :StrudelQuit to quit.")
    return
  end

  local plugin_root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h:h")
  start_local_samples_server(plugin_root)

  local launch_script = plugin_root .. "/js/launch.js"
  local cmd = "node " .. vim.fn.shellescape(launch_script)

  cmd = cmd .. " --doc-json-out=" .. vim.fn.shellescape(doc_json_path)

  cmd = cmd .. " --local-server"
  cmd = cmd .. " --repo-url=" .. vim.fn.shellescape(config.local_server.repo_url)
  cmd = cmd .. " --repo-dir=" .. vim.fn.shellescape(config.local_server.repo_dir)

  if config.ui.hide_top_bar then
    cmd = cmd .. " --hide-top-bar"
  end
  if config.ui.maximise_menu_panel then
    cmd = cmd .. " --maximise-menu-panel"
  end
  if config.ui.hide_menu_panel then
    cmd = cmd .. " --hide-menu-panel"
  end
  if config.ui.hide_code_editor then
    cmd = cmd .. " --hide-code-editor"
  end
  if config.ui.hide_error_display then
    cmd = cmd .. " --hide-error-display"
  end
  if custom_css_b64 then
    cmd = cmd .. " --custom-css-b64=" .. vim.fn.shellescape(custom_css_b64)
  end
  if config.headless then
    cmd = cmd .. " --headless"
  end
  if config.browser_data_dir then
    cmd = cmd .. " --user-data-dir=" .. vim.fn.shellescape(config.browser_data_dir)
  end
  if config.browser_exec_path then
    cmd = cmd .. " --browser-exec-path=" .. vim.fn.shellescape(config.browser_exec_path)
  end

  -- Enable remote debugging so external tools can inspect Strudel runtime.
  -- Default to 9222 unless explicitly disabled.
  local rd_port = config.browser_remote_debug_port
  if rd_port == nil then
    rd_port = 9222
  end
  if type(rd_port) == "number" and rd_port > 0 then
    cmd = cmd .. " --remote-debug-port=" .. tostring(rd_port)
  end

  local function is_noise_line(line)
    return line:match("^%s*$")
      or line:match("^Browserslist:%s")
      or line:match("^%d%d:%d%d:%d%d")
      or line:match("^%s*astro%s+")
      or line:match("^┃%s")
      or line:match("^>%s")
  end


  vim.schedule(function()
    log.reset_run({ title = "Strudel: launch", status = "running", focus = true })
    log.output({ "starting...", "" })
  end)

  -- Run the js script
  strudel_job_id = vim.fn.jobstart(cmd, {
    stdout_buffered = false,
    stderr_buffered = false,
    on_stderr = function(_, data)
      if not data then
        return
      end

      local printable = {}
      for _, line in ipairs(data) do
        if type(line) == "string" and line ~= "" and not is_noise_line(line) then
          table.insert(printable, line)
        end
      end

      if #printable > 0 then
        vim.schedule(function()
          log.output(printable)
        end)
      end
    end,
    on_stdout = function(_, data)
      if not data then
        return
      end

      local non_proto = {}
      for _, line in ipairs(data) do
        if line ~= "" then
          table.insert(event_queue, line)
          if not line:match("^STRUDEL_") then
            table.insert(non_proto, line)
          end
        end
      end

      if #non_proto > 0 then
        vim.schedule(function()
          log.output(non_proto)
        end)
      end

      process_event_queue()
    end,
    on_exit = function(_, code)
      vim.schedule(function()
        log.attach_job(nil)
        if code == 0 then
          log.output({ "", "session closed" })
          log.attach_job(nil)
        else
          log.output({ "", "process exited with code " .. tostring(code) })
          log.error("Strudel process exited with code " .. tostring(code), { notify = true })
        end
      end)

      stop_local_samples_server()

      -- reset state
      strudel_ready = false
      local stopped_strudel_id = strudel_job_id
      strudel_job_id = nil
      vim.schedule(function()
        if log.get_job_id() == stopped_strudel_id then
          log.attach_job(nil)
        end
      end)
      last_content = nil
      strudel_synced_bufnr = nil
      last_received_cursor = nil
      lsp_client_id = nil
      local stopped_docgen_id = docgen_job_id
      if stopped_docgen_id then
        pcall(vim.fn.jobstop, stopped_docgen_id)
      end
      docgen_job_id = nil
      vim.schedule(function()
        if log.get_job_id() == stopped_docgen_id then
          log.attach_job(nil)
        end
      end)
      docgen_running = false
      docgen_failed = nil
      docgen_failed_at = nil
      if docgen_retry_timer then
        pcall(function()
          docgen_retry_timer:stop()
          docgen_retry_timer:close()
        end)
      end
      docgen_retry_timer = nil
      pending_lsp_bufs = {}
    end,
  })

  M.set_buffer()
end

function M.is_launched()
  return strudel_job_id ~= nil
end

function M.quit()
  stop_local_samples_server()
  send_message(MESSAGES.QUIT)
end

function M.toggle()
  send_message(MESSAGES.TOGGLE)
end

function M.update()
  send_message(MESSAGES.UPDATE)
end

function M.stop()
  stop_local_samples_server()
  send_message(MESSAGES.STOP)
end

function M.set_buffer(opts)
  -- Only clear buffer-local sync autocmds; keep the global LspAttach filter.
  if strudel_synced_bufnr and vim.api.nvim_buf_is_valid(strudel_synced_bufnr) then
    vim.api.nvim_clear_autocmds({ group = STRUDEL_SYNC_AUTOCOMMAND, buffer = strudel_synced_bufnr })
  end

  if not strudel_job_id then
    log.warn("No active Strudel session")
    return false
  end

  local bufnr = opts and opts.args and opts.args ~= "" and tonumber(opts.args) or vim.api.nvim_get_current_buf()
  if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then
    log.error("Invalid buffer number for :StrudelSetBuffer")
    return false
  end

  strudel_synced_bufnr = bufnr

  send_buffer_content()

  -- Set up autocommand to sync buffer changes
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    group = STRUDEL_SYNC_AUTOCOMMAND,
    buffer = bufnr,
    callback = function()
      if not is_processing_event and strudel_synced_bufnr then
        send_buffer_content()
      end
    end,
  })

  -- Set up autocommand to sync cursor position if enabled
  if config.sync_cursor then
    vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
      group = STRUDEL_SYNC_AUTOCOMMAND,
      buffer = bufnr,
      callback = function()
        if not is_processing_event then
          send_cursor_position()
        end
      end,
    })
  end

  -- Set up autocommand to update on save
  if config.update_on_save then
    vim.api.nvim_create_autocmd("BufWritePost", {
      group = STRUDEL_SYNC_AUTOCOMMAND,
      buffer = bufnr,
      callback = function()
        if strudel_job_id then
          -- Use the REFRESH message to update only when already playing
          send_message(MESSAGES.REFRESH)
        end
      end,
    })
  end

  local buffer_name = vim.fn.bufname(bufnr)
  if buffer_name == "" then
    buffer_name = "#" .. bufnr
  end
  log.info("Strudel is now syncing buffer " .. buffer_name)

  return true
end

-- Combo command to set the current buffer and trigger update
function M.execute()
  local ok = M.set_buffer()
  if ok then
    vim.defer_fn(function()
      M.update()
    end, SUCCESSIVE_CMD_DELAY * 2)
  end
end

return M
