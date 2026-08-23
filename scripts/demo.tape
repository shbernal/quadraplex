# README demo: a tour of the dashboard over the local store. Rendered by demo.sh.
Set Shell "bash"
Set FontFamily "CaskaydiaMono Nerd Font"
Set FontSize 15
Set Width 1500
Set Height 916
Set Padding 16
Set Framerate 25
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms
Set WaitTimeout 30s

Hide
Type "bind 'set show-mode-in-prompt off'; PS1='$ '; clear"
Enter
Show

Type "qplex"
Sleep 400ms
Enter
Wait+Screen /SOURCES/
Sleep 2s

Type@250ms "jjjj"
Sleep 1s
Tab
Sleep 1.2s
Type@250ms "jjj"
Sleep 1s
Type "s"
Sleep 1.5s
Tab
Sleep 1.5s
Tab
Sleep 1.5s

Type "/"
Sleep 400ms
Type "feed"
Sleep 600ms
Enter
Sleep 2s
Type "c"
Sleep 1s

Type "1"
Sleep 600ms
Enter
Wait+Screen /issues|PRs|releases/
Sleep 3s
Escape
Sleep 1s

Type "?"
Sleep 3s
Escape
Sleep 800ms
Type "q"
Sleep 600ms
