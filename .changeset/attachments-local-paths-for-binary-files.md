---
'kimaki': patch
---

Discord attachments that OpenCode cannot show inline now reach the model as local file paths.

OpenCode V2 only shows png, jpeg, gif and webp images, PDFs and text files to the model. Other files (zip, mp4, HEIC photos, audio that is not a voice message) were dropped without a trace, and a file over 20 MB failed the whole message. Now the prompt gets a block that lists where these files are on disk, so the agent can read them with tools:

```
<local-files>
Attachments saved on disk. OpenCode cannot show these inline; use tools to read them.
~/.kimaki/attachments/1234/0-archive.zip
</local-files>
```

Files over 20 MB are only listed there and not attached, so the message no longer fails.
