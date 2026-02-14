#!/usr/bin/env tsx
import { createOpencodeClient } from '@opencode-ai/sdk'

async function listProjectsAndData() {
  // Connect to OpenCode server
  // Default port is 3318, but you can override with OPENCODE_PORT env var
  const port = process.env.OPENCODE_PORT || '3318'
  const baseUrl = `http://localhost:${port}`

  console.log(`Connecting to OpenCode server at ${baseUrl}...`)
  console.log('(Make sure OpenCode is running with: opencode internal-server)\n')

  const client = createOpencodeClient({ baseUrl })

  console.log('=== OpenCode SDK Project Information ===\n')

  try {
    const projectsResponse = await client.project.list()
    if (!projectsResponse.data) {
      console.error('Failed to fetch projects')
      return
    }
    const projects = projectsResponse.data
    console.log(`Found ${projects.length} project(s)\n`)

    for (const project of projects) {
      console.log(`📁 Project ID: ${project.id}`)
      console.log(`   Worktree: ${project.worktree}`)
      console.log(`   VCS: ${project.vcs || 'none'}`)

      // Get git info if it's a git repo
      if (project.vcs === 'git') {
        try {
          const { exec } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const execAsync = promisify(exec)

          // Get current branch
          const { stdout: branch } = await execAsync('git branch --show-current', {
            cwd: project.worktree,
          })
          if (branch.trim()) {
            console.log(`   Branch: ${branch.trim()}`)
          }

          // Get remotes
          const { stdout: remotesOutput } = await execAsync('git remote', {
            cwd: project.worktree,
          })
          const remoteNames = remotesOutput.trim().split('\n').filter(Boolean)

          if (remoteNames.length > 0) {
            console.log(`   Git Remotes:`)
            for (const remoteName of remoteNames) {
              const { stdout: url } = await execAsync(`git remote get-url ${remoteName}`, {
                cwd: project.worktree,
              })
              console.log(`     ${remoteName}: ${url.trim()}`)
            }
          }
        } catch (e) {
          // Git info not available or error
        }
      }

      console.log(`   Created: ${new Date(project.time.created).toLocaleString()}`)
      if (project.time.initialized) {
        console.log(`   Initialized: ${new Date(project.time.initialized).toLocaleString()}`)
      }
      console.log()

      console.log('   Available Data:')

      try {
        const sessionsResponse = await client.session.list()
        if (sessionsResponse.data) {
          const projectSessions = sessionsResponse.data.filter((s) => s.projectID === project.id)
          console.log(`   - Sessions: ${projectSessions.length}`)

          if (projectSessions.length > 0) {
            const latestSession = projectSessions.sort((a, b) => b.time.updated - a.time.updated)[0]
            if (latestSession) {
              console.log(
                `     Latest: "${latestSession.title}" (${new Date(latestSession.time.updated).toLocaleString()})`,
              )
            }
          }
        }
      } catch (e) {
        console.log(`   - Sessions: Error fetching`)
      }

      try {
        const pathResponse = await client.path.get()
        if (pathResponse.data) {
          console.log(`   - Paths:`)
          console.log(`     State: ${pathResponse.data.state}`)
          console.log(`     Config: ${pathResponse.data.config}`)
          console.log(`     Worktree: ${pathResponse.data.worktree}`)
          console.log(`     Directory: ${pathResponse.data.directory}`)
        }
      } catch (e) {
        console.log(`   - Paths: Error fetching`)
      }

      try {
        const fileStatusResponse = await client.file.status()
        if (fileStatusResponse.data) {
          const modifiedCount = fileStatusResponse.data.filter(
            (f) => f.status === 'modified',
          ).length
          const addedCount = fileStatusResponse.data.filter((f) => f.status === 'added').length
          const deletedCount = fileStatusResponse.data.filter((f) => f.status === 'deleted').length
          console.log(`   - File Status:`)
          console.log(`     Modified: ${modifiedCount} files`)
          console.log(`     Added: ${addedCount} files`)
          console.log(`     Deleted: ${deletedCount} files`)
        }
      } catch (e) {
        console.log(`   - File Status: Error fetching`)
      }

      console.log('\n---\n')
    }

    console.log('=== Current Project Details ===\n')

    try {
      const currentProjectResponse = await client.project.current()
      if (!currentProjectResponse.data) {
        console.error('Failed to fetch current project')
        return
      }
      const currentProject = currentProjectResponse.data
      console.log(`Current Project: ${currentProject.id}`)
      console.log(`Worktree: ${currentProject.worktree}`)

      const configResponse = await client.config.get()
      if (configResponse.data) {
        const config = configResponse.data
        console.log('\nConfiguration:')
        console.log(`- Theme: ${config.theme || 'default'}`)
        console.log(`- Model: ${config.model || 'default'}`)
        console.log(`- Small Model: ${config.small_model || 'default'}`)
        console.log(`- Username: ${config.username || 'anonymous'}`)
        console.log(`- Share Mode: ${config.share || 'manual'}`)
        console.log(`- Autoupdate: ${config.autoupdate !== false}`)
        console.log(`- Snapshot: ${config.snapshot !== false}`)
        console.log(`- Instructions: ${config.instructions?.length || 0} custom instructions`)
      }

      const providersResponse = await client.config.providers()
      if (providersResponse.data) {
        const providers = providersResponse.data.providers
        console.log(`\nProviders: ${providers.length} available`)
        providers.slice(0, 5).forEach((provider) => {
          const modelCount = Object.keys(provider.models).length
          console.log(`  - ${provider.name}: ${modelCount} models`)
        })
        if (providers.length > 5) {
          console.log(`  ... and ${providers.length - 5} more`)
        }
      }

      const commandsResponse = await client.command.list()
      if (commandsResponse.data) {
        const commands = commandsResponse.data
        console.log(`\nCommands: ${commands.length} available`)
        commands.slice(0, 5).forEach((cmd) => {
          console.log(`  - /${cmd.name}: ${cmd.description || 'No description'}`)
        })
        if (commands.length > 5) {
          console.log(`  ... and ${commands.length - 5} more`)
        }
      }

      const agentsResponse = await client.app.agents()
      if (agentsResponse.data) {
        const agents = agentsResponse.data
        console.log(`\nAgents: ${agents.length} available`)
        agents.slice(0, 5).forEach((agent) => {
          console.log(`  - ${agent.name}: ${agent.description || 'No description'}`)
          console.log(`    Mode: ${agent.mode}, Built-in: ${agent.builtIn}`)
        })
        if (agents.length > 5) {
          console.log(`  ... and ${agents.length - 5} more`)
        }
      }
    } catch (e) {
      console.error('Error fetching current project details:', e)
    }
  } catch (error) {
    console.error('Error listing projects:', error)
    process.exit(1)
  } finally {
    process.exit(0)
  }
}

listProjectsAndData().catch(console.error)
