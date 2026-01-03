local M = {}

local kind_text = vim.lsp.protocol.CompletionItemKind.Text
local plain_text = vim.lsp.protocol.InsertTextFormat.PlainText

function M.new()
  return setmetatable({}, { __index = M })
end

function M:get_completions(_, callback)
  local ok, strudel = pcall(require, "strudel")
  if not ok then
    callback({ is_incomplete_forward = false, is_incomplete_backward = false, items = {} })
    return
  end

  local words = strudel.get_completions()
  local items = {}
  for i = 1, #words do
    local w = words[i]
    items[i] = {
      label = w,
      kind = kind_text,
      insertTextFormat = plain_text,
      insertText = w,
    }
  end

  callback({ is_incomplete_forward = false, is_incomplete_backward = false, items = items })
end

return M
