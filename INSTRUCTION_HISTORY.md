# Instruction History

This file records all instructions sent to this project.

## 2026-03-29T09:13:48.655Z

I have been getting error: ⬦ Internal Server Error: Internal Server Error (ref: 1e206ac4-6673-4f0b-856e-9d38f9b48601) - retrying in 2s (attempt #1)

 Found the issue! In /Users/caffae/Local-Projects-2026/kimaki/discord/src/message-formatting.ts, the formatTodoList function calls todos.findIndex without checking if todos is actually an array first. The error "todos.findIndex is not a function" means todos is sometimes not an array.

## 2026-03-29T09:18:37.259Z

Help me reinstall kimaki

## 2026-03-29T09:22:07.485Z

You reinstalled the wrong version, I want my variant (which is in this folder). I should see my banner, but when I tried to run kimaki, it did not appear.

## 2026-03-29T09:24:31.287Z

Add a note in this directory or change the build instructions, so that instead of the global kimaki, we always link the local variant.

## 2026-03-29T09:26:02.095Z

do a git commit

## 2026-03-29T09:31:13.713Z

Do npm link for my local kimaki
