---
'kimaki': minor
---

Add back `--allow-all-users`: every member of the server can use the bot, without the Kimaki role, Administrator or Manage Server.

```bash
kimaki --allow-all-users
```

Useful for public demo servers. The `no-kimaki` role still blocks a user, and `/login` and `/transcription-key` stay limited to the server owner and Administrators. The flag is also kept in the autostart script.
