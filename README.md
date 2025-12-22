<div align='center'>
    <br/>
    <br/>
    <h3>kimaki</h3>
    <p>IronMan's Jarvis for coding agents, inside Discord</p>
    <br/>
    <br/>
</div>

Kimaki is a Discord bot you can install in a Discord server to control opencode sessions in any computer via Discord

When running the `kimaki` cli the first time the cli will ask you choose what existing opencode projects to add to Discord, Kimaki will create a new channel for each project. Writing a message in that channel will start a new opencode session

Kimaki will store the bot state in a local sqlite database. You should keep the kimaki cli running to be able to communicate to it via Discord

## Usage

`npx -y kimaki@latest`

The cli will ask you for

- Discord bot app id and token
- What opencode projects add to Discord
- Gemini API key for audio transcriptions and voice channels interaction

Kimaki requires you to create a new Discord bot for each new computer you will install kimaki in. You can create as many bots as you want, then install each bot in spare machines to be able to control these machines via Discord. Each Discord channel will be associated with a specific machine and project directory.

## Best Practices

- **Set notifications to mentions only** - This way you won't be spammed with notifications during a session. When a session finishes, the bot adds a ✅ reaction to your initial message (or ❌ on error), so you can check the thread at your convenience.

- **Send long messages as files** - Discord has a character limit for free users. To send longer prompts, tap the plus icon in Discord and use "Send message as file". File attachments don't count towards the message limit and Kimaki will read the file content as your prompt.

- **Permissions** - Only server owners and users with Administrator permissions can interact with the bot. Other users' messages are ignored.
