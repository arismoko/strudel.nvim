local M = {}

local STATE = {
  buf = nil,
  win = nil,
  job_id = nil,
  title = nil,
  status = nil,
  lines = {},
  max_lines = 2000,
}

local function is_valid_win(win)
  return win and vim.api.nvim_win_is_valid(win)
end

local function is_valid_buf(buf)
  return buf and vim.api.nvim_buf_is_valid(buf)
end

local function now()
  return os.date("%H:%M:%S")
end

local function status_prefix()
  if not STATE.status then
    return ""
  end
  return "[" .. STATE.status .. "] "
end

local function header_lines()
  local title = STATE.title or "Strudel"
  local job = STATE.job_id and (" job=" .. tostring(STATE.job_id)) or ""
  local line1 = status_prefix() .. title .. job
  local line2 = "(" .. now() .. ")"
  return { line1, line2, "" }
end

local function update_winbar()
  if not is_valid_win(STATE.win) then
    return
  end

  vim.wo[STATE.win].winbar = "Strudel Logs  (q) close  (c) cancel"
end

local function redraw_buffer(keep_view)
  if not is_valid_buf(STATE.buf) then
    return
  end

  update_winbar()

  local win = STATE.win
  local view = nil
  if keep_view and is_valid_win(win) then
    view = vim.fn.winsaveview()
  end

  vim.api.nvim_buf_set_option(STATE.buf, "modifiable", true)
  vim.api.nvim_buf_set_lines(STATE.buf, 0, -1, false, header_lines())
  vim.api.nvim_buf_set_lines(STATE.buf, -1, -1, false, STATE.lines)
  vim.api.nvim_buf_set_option(STATE.buf, "modifiable", false)

  if view and is_valid_win(win) then
    pcall(vim.fn.winrestview, view)
  end
end

local function ensure_buf()
  if is_valid_buf(STATE.buf) then
    return STATE.buf
  end

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, "strudel://logs")
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].swapfile = false
  vim.bo[buf].bufhidden = "wipe"
  -- Avoid `ft=strudel` so the Strudel LSP doesn't attach.
  vim.bo[buf].filetype = "strudel_log"
  vim.bo[buf].modifiable = false

  STATE.buf = buf

  vim.keymap.set("n", "q", function()
    M.hide()
  end, { buffer = buf, silent = true })

  vim.keymap.set("n", "c", function()
    M.cancel()
  end, { buffer = buf, silent = true })

  vim.keymap.set("n", "<Esc>", function()
    M.hide()
  end, { buffer = buf, silent = true })

  redraw_buffer(false)
  return buf
end

local function float_config()
  local w = math.floor(vim.o.columns * 0.8)
  local h = math.floor(vim.o.lines * 0.7)
  local row = math.floor((vim.o.lines - h) / 2)
  local col = math.floor((vim.o.columns - w) / 2)
  return {
    relative = "editor",
    width = w,
    height = h,
    row = row,
    col = col,
    style = "minimal",
    border = "rounded",
  }
end

function M.open(opts)
  opts = opts or {}
  STATE.title = opts.title or STATE.title or "Strudel"
  if opts.job_id ~= nil then
    STATE.job_id = opts.job_id
  end
  if opts.status ~= nil then
    STATE.status = opts.status
  elseif not STATE.status then
    STATE.status = "running"
  end

  local buf = ensure_buf()

  if is_valid_win(STATE.win) then
    if opts.focus then
      pcall(vim.api.nvim_set_current_win, STATE.win)
    end
    redraw_buffer(true)
    return
  end

  local win = vim.api.nvim_open_win(buf, opts.focus == true, float_config())
  STATE.win = win
  vim.wo[win].wrap = false
  vim.wo[win].cursorline = false
  vim.wo[win].signcolumn = "no"
  vim.wo[win].number = false
  vim.wo[win].relativenumber = false

  redraw_buffer(false)
end

function M.hide()
  if is_valid_win(STATE.win) then
    pcall(vim.api.nvim_win_close, STATE.win, true)
  end
  STATE.win = nil
end

function M.reset(opts)
  opts = opts or {}
  STATE.lines = {}
  STATE.title = opts.title or STATE.title
  STATE.status = opts.status
  STATE.job_id = opts.job_id
  ensure_buf()
  redraw_buffer(false)
end

function M.append(lines)
  if not lines then
    return
  end

  if type(lines) == "string" then
    lines = { lines }
  end

  local buf = ensure_buf()
  local win = STATE.win
  local should_follow = false

  if is_valid_win(win) then
    local cursor = vim.api.nvim_win_get_cursor(win)
    local last_line = vim.api.nvim_buf_line_count(buf)
    should_follow = cursor[1] >= (last_line - 2)
  end

  for _, line in ipairs(lines) do
    if type(line) == "string" and line ~= "" then
      table.insert(STATE.lines, line)
    end
  end

  if #STATE.lines > STATE.max_lines then
    local drop = #STATE.lines - STATE.max_lines
    for _ = 1, drop do
      table.remove(STATE.lines, 1)
    end
  end

  redraw_buffer(true)

  if should_follow and is_valid_win(win) then
    local last = vim.api.nvim_buf_line_count(buf)
    pcall(vim.api.nvim_win_set_cursor, win, { last, 0 })
  end
end

function M.set_status(status)
  STATE.status = status
  redraw_buffer(true)
end

function M.set_job(job_id)
  STATE.job_id = job_id
  redraw_buffer(true)
end

function M.cancel()
  if STATE.job_id and STATE.job_id > 0 then
    pcall(vim.fn.jobstop, STATE.job_id)
    M.append("[" .. now() .. "] cancel requested")
    M.set_status("cancelled")
  end
end

function M.get_job()
  return STATE.job_id
end

return M
