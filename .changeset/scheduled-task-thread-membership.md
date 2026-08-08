---
'kimaki': patch
---

Make scheduled tasks show up in your Discord sidebar, and edit model/agent without recreate.

Discord only lists a thread in the left sidebar for people who are **members of that thread**. Tasks created without `--user` never add anyone as a member, so they could fire completely unnoticed.

**`kimaki task list` now prints `userId`, `agent`, and `model`** so you can spot tasks that notify nobody and see which model will run.

```
id | status | message | channelId | userId | projectName | folderName | agent | model | ...
5  | planned | Reply to unread emails | 1422... | - | my-project | GitHub | - | -
19 | planned | Run daily news desk | 1532... | 5359... | chiavarinews | GitHub | - | opencode-go/deepseek-v4-flash
```

A `-` in `userId` means no thread member gets added when the task fires, so it may go unseen.

**`kimaki task edit` can set user, model, and agent on an existing task**, instead of delete + recreate.

```bash
kimaki task edit 5 --user '535922349652836367'
kimaki task edit 19 --model 'opencode-go/deepseek-v4-flash' --send-at '0 4 * * *'
# empty string clears the override
kimaki task edit 19 --agent ''
```

Raw IDs and `<@id>` mentions resolve offline; usernames still need a bot token and Server Members Intent.

**`kimaki send --user` now works with `--thread` and `--session`.** It was previously rejected as incompatible, which meant thread reminders could never resurface a thread you had left. The user is re-added as a thread member both for immediate sends and when a scheduled thread task fires. This works even if the thread auto-archived in the meantime, since posting the reminder unarchives it.

```bash
kimaki send --thread 1535226265148063816 \
  --prompt 'Reminder: you asked to be reminded about this thread.' \
  --send-at '2026-08-07T18:00:00Z' \
  --user '535922349652836367'
```
