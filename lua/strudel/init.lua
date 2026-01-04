local base64 = require("strudel.base64")

local M = {}

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
local lsp_started = false
local doc_json_path = nil

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
    enabled = true,
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
          vim.notify("Strudel local samples: failed to decode READY", vim.log.levels.WARN)
          return
        end

        local ok2, payload = pcall(vim.json.decode, decoded)
        if not ok2 or type(payload) ~= "table" then
          vim.notify("Strudel local samples: invalid READY payload", vim.log.levels.WARN)
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
          vim.notify("Strudel local samples error: " .. decoded, vim.log.levels.WARN)
        else
          vim.notify("Strudel local samples error", vim.log.levels.WARN)
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
    vim.notify("No active Strudel session", vim.log.levels.WARN)
  end
end
local function set_samples(samples)
  stored_samples = samples
end

function M.import_local_samples()
  if not strudel_job_id then
    vim.notify("No active Strudel session", vim.log.levels.WARN)
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
    vim.notify("Strudel local samples: waiting for server...", vim.log.levels.INFO)
  else
    vim.notify("Strudel local samples: no samples folder detected", vim.log.levels.INFO)
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

local function start_lsp(bufnr)
  if lsp_started or not config.lsp.enabled then
    return
  end

  if not doc_json_path then
    vim.notify("Strudel: doc.json not ready; LSP disabled", vim.log.levels.WARN)
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

  local ok = pcall(vim.lsp.start, {
    name = "strudel",
    cmd = cmd,
    root_dir = plugin_root,
    bufnr = bufnr,
  })

  if ok then
    lsp_started = true

    -- If we already received samples before LSP started, replay them.
    notify_lsp_samples(stored_samples)
  end
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
      start_lsp(strudel_synced_bufnr)
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
        vim.notify(
          string.format(
            "Strudel local samples: imported %d sounds (soundMap now %s)",
            #payload.importedKeys,
            tostring(payload.soundCountAfter or "?")),
          vim.log.levels.INFO)
      else
        vim.notify("Strudel local samples: imported", vim.log.levels.INFO)
      end
    end)
  elseif full_data:match("^STRUDEL_IMPORT_LOCAL_SAMPLES_ERROR:") then
    local b64 = full_data:sub(#"STRUDEL_IMPORT_LOCAL_SAMPLES_ERROR:" + 1)
    local decoded = base64.decode(b64)
    vim.schedule(function()
      vim.notify("Strudel local samples import failed: " .. decoded, vim.log.levels.WARN)
    end)
  elseif full_data:match("^" .. MESSAGES.EVAL_ERROR) then
    local error_b64 = full_data:sub(#MESSAGES.EVAL_ERROR + 1)
    local error = base64.decode(error_b64)
    if config.report_eval_errors then
      vim.schedule(function()
        vim.notify("Strudel Error: " .. error, vim.log.levels.ERROR)
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
      vim.notify("Could not read custom CSS file: " .. css_path, vim.log.levels.ERROR)
    end
  end

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
          vim.notify("Strudel session not running. Use :StrudelLaunch", vim.log.levels.INFO)
        end)
      end
    end,
  })


  -- Provide JavaScript syntax highlighting while keeping ft=strudel.
  vim.api.nvim_create_autocmd("FileType", {
    group = STRUDEL_SYNC_AUTOCOMMAND,
    pattern = "strudel",
    callback = function(ev)
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
end

function M.launch()
  if strudel_job_id ~= nil then
    vim.notify("Strudel is already running, run :StrudelQuit to quit.", vim.log.levels.ERROR)
    return
  end

  local plugin_root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h:h")
  start_local_samples_server(plugin_root)

  local launch_script = plugin_root .. "/js/launch.js"
  local cmd = "node " .. vim.fn.shellescape(launch_script)

  doc_json_path = vim.fn.stdpath("cache") .. "/strudel-nvim/doc.json"
  cmd = cmd .. " --doc-json-out=" .. vim.fn.shellescape(doc_json_path)

  if config.local_server.enabled then
    cmd = cmd .. " --local-server"
    cmd = cmd .. " --repo-url=" .. vim.fn.shellescape(config.local_server.repo_url)
    cmd = cmd .. " --repo-dir=" .. vim.fn.shellescape(config.local_server.repo_dir)
  end

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

  local function is_real_error_line(line)
    -- Heuristic: only escalate obvious failures.
    return line:lower():match("error")
      or line:lower():match("failed")
      or line:lower():match("exception")
      or line:lower():match("traceback")
  end

  -- Run the js script
  strudel_job_id = vim.fn.jobstart(cmd, {
    on_stderr = function(_, data)
      if not data then
        return
      end

      for _, line in ipairs(data) do
        if line ~= "" and not is_noise_line(line) then
          local level = is_real_error_line(line) and vim.log.levels.ERROR or vim.log.levels.INFO
          vim.notify("Strudel: " .. line, level)
        end
      end
    end,
    on_stdout = function(_, data)
      if not data then
        return
      end

      for _, line in ipairs(data) do
        if line ~= "" then
          table.insert(event_queue, line)
        end
      end

      process_event_queue()
    end,
    on_exit = function(_, code)
      if code == 0 then
        vim.notify("Strudel session closed", vim.log.levels.INFO)
      else
        vim.notify("Strudel process error: " .. code, vim.log.levels.ERROR)
      end

      stop_local_samples_server()

      -- reset state
      strudel_ready = false
      strudel_job_id = nil
      last_content = nil
      strudel_synced_bufnr = nil
      last_received_cursor = nil
      lsp_started = false
      doc_json_path = nil
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
    vim.notify("No active Strudel session", vim.log.levels.WARN)
    return false
  end

  local bufnr = opts and opts.args and opts.args ~= "" and tonumber(opts.args) or vim.api.nvim_get_current_buf()
  if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then
    vim.notify("Invalid buffer number for :StrudelSetBuffer", vim.log.levels.ERROR)
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
  vim.notify("Strudel is now syncing buffer " .. buffer_name, vim.log.levels.INFO)

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
