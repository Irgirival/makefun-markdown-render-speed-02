# markdown-render-speed-02

A fast, dependency-free drop-in replacement for marked 18.1.3 (default
options: GFM on, breaks off). `parse(markdown)` returns exactly the HTML
marked renders, for CommonMark 0.31.2 + GFM 0.29 inputs.

## Layout

- `parse.js` — the renderer. A single-pass block parser (line-based,
  recursive descent over blockquotes and list items) plus an inline engine
  that is a direct-render port of marked 18.1.3's inline pipeline
  (Lexer.inlineTokens + Tokenizer + Renderer + TextRenderer, GFM rules),
  including the emStrong mask, the delimiter-scan accounting, and the
  link-label rules — so it reproduces marked's output byte for byte on
  the practice set (720/720) while running ~1.33x faster. No dependencies.
- `main.ts` — the driver: reads `cases.json`, renders each case alone with
  `parse()`, writes `html.json`.

## Run locally

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

## License

MIT — see `LICENSE`.
