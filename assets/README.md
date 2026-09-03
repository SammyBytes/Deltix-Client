# Assets — Demos

These GIFs are placeholders for the real `vhs` recordings.

To regenerate with `vhs` (requires `go install github.com/charmbracelet/vhs@latest`):

```bash
vhs demo-quickstart.tape  # → demo-quickstart.gif
vhs demo-branch.tape      # → demo-branch.gif
vhs demo-status.tape      # → demo-status.gif
vhs demo-drizzle.tape     # → demo-drizzle.gif
```

Tapes are in `assets/tapes/` — each runs in an isolated `/tmp` repo (`demo-hello`, no real data).
