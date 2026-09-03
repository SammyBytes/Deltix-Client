Output demo-drizzle.gif
Set Shell "bash"
Set FontSize 14
Set Width 800
Set Height 400
Set Theme "Catppuccin Mocha"

Type "DATABASE_URL=mysql://root@127.0.0.1:3307/demo-hello bun run db:migrate" Enter
Sleep 800ms
Type "deltix status" Enter
Sleep 800ms
Type "deltix commit -m 'add email column'" Enter
Sleep 800ms
