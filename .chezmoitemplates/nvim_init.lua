local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable", -- latest stable release
    lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

vim.o.termguicolors = true
vim.g.mapleader = " "
vim.g.maplocalleader = " "
vim.wo.relativenumber = true
vim.bo.tabstop = 4
vim.bo.shiftwidth = 4
vim.bo.expandtab = true

-- Enable line number:Lss
vim.wo.number = true

require("lazy").setup({
  defaults = {
    version = false,
  },
  "folke/which-key.nvim",
  { "folke/neoconf.nvim", cmd = "Neoconf" },
  "folke/neodev.nvim",
  {
    "folke/which-key.nvim",
    event = "VeryLazy",
    init = function()
      vim.o.timeout = true
      vim.o.timeoutlen = 200
    end,
    opts = {
    }
  },
  {
    "ellisonleao/gruvbox.nvim",
    priority = 1000,
    config = true,
    opts = {},
    init = function()
      vim.cmd [[colorscheme gruvbox]]
    end,
  },
  {
    'nvim-lualine/lualine.nvim',
    dependencies = { 'nvim-tree/nvim-web-devicons' },
    config = function()
      require("lualine").setup({})
    end,
  },
  {
    "nvim-telescope/telescope.nvim",
    dependencies = { 'nvim-lua/plenary.nvim' },
    config = function()
      require("telescope").setup({})
    end,
  },

  {
    'nmac427/guess-indent.nvim',
    config = function() require('guess-indent').setup {} end,
  },

  -- Blink.cmp (Replaces nvim-cmp)
  {
    'Saghen/blink.cmp',
    version = '1.*',
    dependencies = {
      'neovim/nvim-lspconfig',
      'L3MON4D3/LuaSnip', -- Keeping your snippet engine
      'fang2hou/blink-copilot',
    },
    opts = {
      -- Configure keymap - this is a top-level field
      keymap = {
        preset = 'default',
        -- Add any custom keymaps
        ['<C-d>'] = { 'scroll_documentation_down', 'fallback' },
        ['<C-f>'] = { 'scroll_documentation_up', 'fallback' },
        ['<C-Space>'] = { 'show', 'fallback' },
        ['<CR>'] = { 'accept', 'fallback' },
        ['<Tab>'] = { 'select_next', 'fallback' },
        ['<S-Tab>'] = { 'select_prev', 'fallback' },
      },
      completion = { documentation = { auto_show = true } },
      -- Configure sources
      sources = {
        default = {
          'lsp',      -- LSP completions
          'copilot',  -- Copilot completions
          'snippets', -- Snippet completions
          'buffer',   -- Buffer-based completions
          'path',     -- Path completions
        },
        providers = {
          copilot = {
            name = "copilot",
            module = "blink-copilot",
            score_offset = -100,
            async = true,
            transform_items = function(ctx, items)
              for _, item in ipairs(items) do
                item.kind_icon = ''
                item.kind_name = 'Copilot'
              end
              return items
            end
          }
        },
      },
      fuzzy = {
        sorts = {
          'score',
          'sort_text',
          'label',
        },
        implementation = "prefer_rust_with_warning"
      },
    },
    opts_extend = { "sources.default" }
  },

  -- Fucking LSP garbage
  "mason-org/mason.nvim",
  "mason-org/mason-lspconfig.nvim",
  "neovim/nvim-lspconfig",
  {
    'mbbill/undotree',
    config = function()
      vim.keymap.set('n', '<leader>u', vim.cmd.UndotreeToggle)
      vim.opt.undofile = true
      vim.opt.undodir = vim.fn.expand("~/.undodir")
    end,
  },
  {
    "nvim-tree/nvim-tree.lua",
    version = "*",
    dependencies = {
      "nvim-tree/nvim-web-devicons",
    },
    config = function()
      require("nvim-tree").setup {};
      vim.keymap.set('n', '<leader>t', function()
        local view = require('nvim-tree.view')
        if view.is_visible() then
          if vim.api.nvim_get_current_win() == view.get_winnr() then
            vim.cmd.NvimTreeToggle()
          else
            vim.cmd.NvimTreeFocus()
          end
        else
          vim.cmd.NvimTreeToggle()
        end
      end)
    end,
  },
  --- The Return of The Treesitter
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    config = function()
      local configs = require("nvim-treesitter.configs")
      configs.setup({
        ensure_installed = { "c", "lua", "vim", "vimdoc", "rust" },
        sync_install = false,
        highlight = { enable = true },
        indent = { enable = true },
      })
    end
  },

  {
    'akinsho/bufferline.nvim',
    version = "*",
    dependencies = 'nvim-tree/nvim-web-devicons',
    config = function()
      require("bufferline").setup {}
    end
  },
  {
    'tjdevries/present.nvim'
  },
  {
    "yetone/avante.nvim",
    event = "VeryLazy",
    lazy = false,
    version = false, -- set this if you want to always pull the latest changes
    opts = {
      provider = "groq",
      providers = {
        ["openrouter"] = {
          __inherited_from = 'openai',
          endpoint = 'https://openrouter.ai/api/v1',
          api_key_name = 'OPENROUTER_API_KEY',
          model = 'anthropic/claude-3.5-sonnet',
        },
        ["groq"] = {
          __inherited_from = 'openai',
          endpoint = "https://api.groq.com/openai/v1",
          api_key_name = 'GROQ_API_KEY',
          model = "moonshotai/kimi-k2-instruct",
        },
      },
    },
    -- if you want to build from source then do `make BUILD_FROM_SOURCE=true`
    build = "make BUILD_FROM_SOURCE=true",
    dependencies = {
      "nvim-treesitter/nvim-treesitter",
      "stevearc/dressing.nvim",
      "nvim-lua/plenary.nvim",
      "MunifTanjim/nui.nvim",
      --- The below dependencies are optional,
      "nvim-tree/nvim-web-devicons", -- or echasnovski/mini.icons
      "zbirenbaum/copilot.lua",      -- for providers='copilot'
      {
        -- support for image pasting
        "HakonHarnes/img-clip.nvim",
        event = "VeryLazy",
        opts = {
          -- recommended settings
          default = {
            embed_image_as_base64 = false,
            prompt_for_file_name = false,
            drag_and_drop = {
              insert_mode = true,
            },
            -- required for Windows users
            use_absolute_path = true,
          },
        },
      },
      {
        -- Make sure to set this up properly if you have lazy=true
        'MeanderingProgrammer/render-markdown.nvim',
        opts = {
          file_types = { "markdown", "Avante" },
        },
        ft = { "markdown", "Avante" },
      },
    },
  },

  -- almighty osc copy
  {
    "ojroques/nvim-osc52",
    config = function()
      require("osc52").setup({
        max_length = 0, -- Maximum length of selection (0 for no limit)
        silent = false, -- Disable message on successful copy
        trim = false,   -- Trim surrounding whitespaces before copy
      })
      local function copy()
        if (vim.v.event.operator == "y" or vim.v.event.operator == "d") and vim.v.event.regname == "" then
          require("osc52").copy_register("")
        end
      end

      vim.api.nvim_create_autocmd("TextYankPost", { callback = copy })
    end,
  }
})

require("copilot").setup({
  suggestion = {
    enabled = true,
    auto_trigger = false,
    keymap = {
      accept = "<C-l>",    -- Accept Copilot suggestion
      accept_word = false, -- Or set to a custom key
      accept_line = false, -- Or set to a custom key
      next = "<M-]>",      -- Next Copilot suggestion
      prev = "<M-[>",      -- Previous Copilot suggestion
      dismiss = "<C-]>",   -- Dismiss Copilot suggestion
    },
  },
  panel = { enabled = true },
})


require('nvim-treesitter.install').compilers = { 'clang' }

vim.api.nvim_create_autocmd("BufReadPost", {
  pattern = "*",
  callback = function()
    local last_pos = vim.fn.line("'\"")
    if last_pos > 1 and last_pos <= vim.fn.line("$") then
      vim.api.nvim_win_set_cursor(0, { last_pos, 0 })
    end
  end
})

-- Clipboard setup
vim.opt.clipboard = "unnamedplus"

-- LSP Configuration

local servers = {
  clangd = {},
  basedpyright = {},
  ruff = {},
  rust_analyzer = {},
  lua_ls = {
    Lua = {
      diagnostics = { globals = "vim" },
      workspace = { checkThirdParty = false },
      telemetry = { enable = false },
    },
  },
}

local on_attach = function(_, bufnr)
  local nmap = function(keys, func, desc)
    if desc then
      desc = 'LSP: ' .. desc
    end

    vim.keymap.set('n', keys, func, { buffer = bufnr, desc = desc })
  end
  nmap('<leader>rn', vim.lsp.buf.rename, '[R]e[n]ame')
  nmap('<leader>ca', vim.lsp.buf.code_action, '[C]ode [A]ction')

  nmap('gd', vim.lsp.buf.definition, '[G]oto [D]efinition')
  nmap('gr', require('telescope.builtin').lsp_references, '[G]oto [R]eferences')
  nmap('gI', vim.lsp.buf.implementation, '[G]oto [I]mplementation')
  nmap('<leader>D', vim.lsp.buf.type_definition, 'Type [D]efinition')
  nmap('<leader>ds', require('telescope.builtin').lsp_document_symbols, '[D]ocument [S]ymbols')
  nmap('<leader>ws', require('telescope.builtin').lsp_dynamic_workspace_symbols, '[W]orkspace [S]ymbols')

  -- See `:help K` for why this keymap
  nmap('K', vim.lsp.buf.hover, 'Hover Documentation')
  nmap('<C-k>', vim.lsp.buf.signature_help, 'Signature Documentation')

  vim.api.nvim_buf_create_user_command(bufnr, 'Format', function(_)
    vim.lsp.buf.format()
  end, { desc = 'Format current buffer with LSP' })
end


-- use blink.cmp's LSP capabilities
local capabilities = require('blink.cmp').get_lsp_capabilities(
  vim.lsp.protocol.make_client_capabilities()
)

vim.lsp.config('*', {
  capabilities = capabilities,
  on_attach = on_attach,
})

-- Configure LSP virtual text diagnostics
vim.diagnostic.config({
  virtual_text = false, -- Enable virtual text by default
  signs = true,
  underline = true,
  update_in_insert = false,
  severity_sort = true,
  virtual_lines = false,
})
-- Toggle virtual text function
function _G.toggle_virtual_text()
  local current_config = vim.diagnostic.config()
  vim.diagnostic.config({
    virtual_text = not current_config.virtual_text,
  })
  if current_config.virtual_text then
    print("Virtual text diagnostics disabled")
  else
    print("Virtual text diagnostics enabled")
  end
end

for name, cfg in pairs(servers) do
  vim.lsp.config(name, {
    settings = cfg,
    capabilities = capabilities,
    on_attach = on_attach,
  })
end

vim.lsp.enable(vim.tbl_keys(servers))


require('neodev').setup()
require("mason").setup()
local mason_lspconfig = require("mason-lspconfig")

mason_lspconfig.setup {
  ensure_installed = vim.tbl_keys(servers),
  automatic_enable = true,
}

-- Keymap to toggle virtual text diagnostics
vim.keymap.set('n', '<leader>sv', toggle_virtual_text, { desc = 'Switch Virtual text diagnostics' })

-- LuaSnip setup (maintained for compatibility)
local luasnip = require 'luasnip'
luasnip.config.setup {}

-- Keymaps go here

vim.keymap.set('n', '<leader>?', require('telescope.builtin').oldfiles, { desc = '[?] Find recently opened files' })
vim.keymap.set('n', '<leader><space>', require('telescope.builtin').buffers, { desc = '[ ] Find existing buffers' })
vim.keymap.set('n', '<leader>/', function()
  -- You can pass additional configuration to telescope to change theme, layout, etc.
  require('telescope.builtin').current_buffer_fuzzy_find()
end, { desc = '[/] Fuzzily search in current buffer' })

vim.keymap.set('n', '<leader>ff', require('telescope.builtin').find_files, { desc = '[F]ind [F]iles' })
vim.keymap.set('n', '<leader>fh', require('telescope.builtin').help_tags, { desc = '[F]ind [H]elp' })
vim.keymap.set('n', '<leader>fw', require('telescope.builtin').grep_string, { desc = '[F]ind current [W]ord' })
vim.keymap.set('n', '<leader>fg', require('telescope.builtin').live_grep, { desc = '[F]ind by [G]rep' })
vim.keymap.set('n', '<leader>fd', require('telescope.builtin').diagnostics, { desc = '[F]ind [D]iagnostics' })
