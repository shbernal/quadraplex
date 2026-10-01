# vhs src/tui/concepts/since-last-look/tapes/80x24.tape, run from the repo root.
# vhs drew no frames in the sandbox this was built in; shoot.ts paints the same shots from headless frames.
Output src/tui/concepts/since-last-look/shots/demo.gif
Set Shell bash
Set FontFamily "CaskaydiaMono Nerd Font"
Set FontSize 16
Set Padding 12
Set Width 852
Set Height 506
Set Theme "Catppuccin Mocha"
Hide
Type "clear && SINCE_LAST_LOOK_READONLY=1 bun run src/tui/concepts/since-last-look/index.ts"
Enter
Sleep 2s
Show
Sleep 300ms
Screenshot src/tui/concepts/since-last-look/shots/list-80x24.png
Sleep 300ms
Hide
Down
Down
Enter
Sleep 400ms
Show
Sleep 300ms
Screenshot src/tui/concepts/since-last-look/shots/story-80x24.png
Sleep 300ms
Hide
Type "q"
