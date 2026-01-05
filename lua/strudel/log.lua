local M = {}

local job_ui = require("strudel.job_ui")

local notified_once = {}

local function normalize_lines(lines)
  if not lines then
    return {}
  end
  if type(lines) == "string" then
    return { lines }
  end
  return lines
end

local function append_prefixed(prefix, message)
  job_ui.append(prefix .. message)
end

function M.open(focus)
  job_ui.open({ focus = focus ~= false })
end

function M.reset_run(opts)
  opts = opts or {}
  job_ui.reset({ title = opts.title, status = opts.status or "running", job_id = opts.job_id })
  job_ui.open({ focus = opts.focus ~= false })
end

function M.attach_job(job_id)
  job_ui.set_job(job_id)
end

function M.output(lines)
  job_ui.append(normalize_lines(lines))
end

function M.hint_once(key, message)
  if notified_once[key] then
    return
  end
  notified_once[key] = true

  job_ui.append("[hint] " .. message)
  vim.notify(message, vim.log.levels.INFO)
end

function M.info(message)
  append_prefixed("[info] ", message)
end

function M.warn(message, opts)
  opts = opts or {}
  append_prefixed("[warn] ", message)
  if opts.notify ~= false then
    vim.notify(message, vim.log.levels.WARN)
  end
end

function M.error(message, opts)
  opts = opts or {}
  append_prefixed("[error] ", message)
  job_ui.set_status("failed")
  job_ui.open({ focus = true })
  if opts.notify ~= false then
    vim.notify(message, vim.log.levels.ERROR)
  end
end

function M.cancel()
  job_ui.cancel()
end

function M.get_job_id()
  return job_ui.get_job()
end

return M
