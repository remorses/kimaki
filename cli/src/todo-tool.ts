import { tool } from 'ai'
import { z } from 'zod'
import dedent from 'string-dedent'

const TodoInfo = z.object({
  content: z.string().describe('Brief description of the task'),
  status: z
    .enum(['pending', 'in_progress', 'completed', 'cancelled'])
    .describe(
      'Current status of the task: pending, in_progress, completed, cancelled',
    ),
  priority: z
    .enum(['high', 'medium', 'low'])
    .describe('Priority level of the task: high, medium, low'),
  id: z.string().describe('Unique identifier for the todo item'),
})

type TodoInfo = z.infer<typeof TodoInfo>

const todoWriteDescription = dedent`
  Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
  It also helps the user understand the progress of the task and overall progress of their requests.

  ## When to Use This Tool
  Use this tool proactively in these scenarios:

  1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
  2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
  3. User explicitly requests todo list - When the user directly asks you to use the todo list
  4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
  5. After receiving new instructions - Immediately capture user requirements as todos. Feel free to edit the todo list based on new information.
  6. After completing a task - Mark it complete and add any new follow-up tasks
  7. When you start working on a new task, mark the todo as in_progress. Ideally you should only have one todo as in_progress at a time. Complete existing tasks before starting new ones.

  ## When NOT to Use This Tool

  Skip using this tool when:
  1. There is only a single, straightforward task
  2. The task is trivial and tracking it provides no organizational benefit
  3. The task can be completed in less than 3 trivial steps
  4. The task is purely conversational or informational

  NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

  ## Examples of When to Use the Todo List

  <example>
  User: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!
  Assistant: I'll help add a dark mode toggle to your application settings. Let me create a todo list to track this implementation.
  *Creates todo list with the following items:*
  1. Create dark mode toggle component in Settings page
  2. Add dark mode state management (context/store)
  3. Implement CSS-in-JS styles for dark theme
  4. Update existing components to support theme switching
  5. Run tests and build process, addressing any failures or errors that occur
  *Begins working on the first task*

  <reasoning>
  The assistant used the todo list because:
  1. Adding dark mode is a multi-step feature requiring UI, state management, and styling changes
  2. The user explicitly requested tests and build be run afterward
  3. The assistant inferred that tests and build need to pass by adding "Ensure tests and build succeed" as the final task
  </reasoning>
  </example>

  <example>
  User: Help me rename the function getCwd to getCurrentWorkingDirectory across my project
  Assistant: Let me first search through your codebase to find all occurrences of 'getCwd'.
  *Uses grep or search tools to locate all instances of getCwd in the codebase*
  Assistant: I've found 15 instances of 'getCwd' across 8 different files. Let me create a todo list to track these changes.
  *Creates todo list with specific items for each file that needs updating*

  <reasoning>
  The assistant used the todo list because:
  1. First, the assistant searched to understand the scope of the task
  2. Upon finding multiple occurrences across different files, it determined this was a complex task with multiple steps
  3. The todo list helps ensure every instance is tracked and updated systematically
  4. This approach prevents missing any occurrences and maintains code consistency
  </reasoning>
  </example>


  <example>
  User: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.
  Assistant: I'll help implement these features. First, let's add all the features to the todo list.
  *Creates a todo list breaking down each feature into specific tasks based on the project architecture*
  Assistant: Let's start with user registration. This will involve creating database models, API endpoints, and frontend forms that integrate with your existing authentication system.

  <reasoning>
  The assistant used the todo list because:
  1. The user provided multiple complex features to implement in a comma separated list
  2. The todo list helps organize these large features into manageable tasks
  3. This approach allows for tracking progress across the entire implementation
  </reasoning>
  </example>

  <example>
  User: Can you help optimize my React application? It's rendering slowly and has performance issues.</user>
  Assistant: I'll help optimize your React application. First, let me examine your codebase to identify potential performance bottlenecks.
  *Reviews component structure, render patterns, state management, and data fetching*
  Assistant: After analyzing your codebase, I've identified several performance issues. Let me create a todo list to track our optimization efforts.
  *Creates todo list with items like: 1) Implement memoization for expensive calculations in ProductList, 2) Add virtualization for long lists in Dashboard, 3) Optimize image loading in Gallery component, 4) Fix state update loops in ShoppingCart, 5) Review bundle size and implement code splitting*
  Let's start by implementing memoization for the expensive calculations in your ProductList component.</assistant>

  <reasoning>
  The assistant used the todo list because:
  1. First, the assistant examined the codebase to identify specific performance issues
  2. Based on this analysis, it identified multiple optimization opportunities
  3. Performance optimization is a non-trivial task requiring multiple steps
  4. The todo list helps methodically track improvements across different components
  5. This systematic approach ensures all performance bottlenecks are addressed
  </reasoning>
  </example>

  ## Examples of When NOT to Use the Todo List

  <example>
  User: How do I print 'Hello World' in Python?
  Assistant: In Python, you can print "Hello World" with this simple code:

  python
  print("Hello World")

  This will output the text "Hello World" to the console when executed.</assistant>

  <reasoning>
  The assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.
  </reasoning>
  </example>

  <example>
  User: What does the git status command do?
  Assistant: The git status command shows the current state of your working directory and staging area. It displays which changes have been staged, which haven't, and which files aren't being tracked by Git. This is a fundamental command for understanding the current state of your repository before making commits.

  <reasoning>
  The assistant did not use the todo list because this is an informational request with no actual coding task to complete. The user is simply asking for an explanation, not for the assistant to perform multiple steps or tasks.
  </reasoning>
  </example>

  <example>
  User: Can you add a comment to the calculateTotal function to explain what it does?
  Assistant: Sure, let me add a comment to the calculateTotal function to explain what it does.
  * Uses the Edit tool to add a comment to the calculateTotal function *

  <reasoning>
  The assistant did not use the todo list because this is a single, straightforward task confined to one location in the code. Adding a comment doesn't require tracking multiple steps or systematic organization.
  </reasoning>
  </example>

  <example>
  User: Run npm install for me and tell me what happens.
  Assistant: I'll run the npm install command for you.

  *Executes: npm install*

  The command completed successfully. Here's the output:
  [Output of npm install command]

  All dependencies have been installed according to your package.json file.

  <reasoning>
  The assistant did not use the todo list because this is a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this straightforward task.
  </reasoning>
  </example>

  ## Task States and Management

  1. **Task States**: Use these states to track progress:
     - pending: Task not yet started
     - in_progress: Currently working on (limit to ONE task at a time)
     - completed: Task finished successfully
     - cancelled: Task no longer needed

  2. **Task Management**:
     - Update task status in real-time as you work
     - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
     - Only have ONE task in_progress at any time
     - Complete current tasks before starting new ones
     - Cancel tasks that become irrelevant

  3. **Task Breakdown**:
     - Create specific, actionable items
     - Break complex tasks into smaller, manageable steps
     - Use clear, descriptive task names

  When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.
`

const todoReadDescription = dedent`
  Use this tool to read the current to-do list for the session. This tool should be used proactively and frequently to ensure that you are aware of
  the status of the current task list. You should make use of this tool as often as possible, especially in the following situations:
  - At the beginning of conversations to see what's pending
  - Before starting new tasks to prioritize work
  - When the user asks about previous tasks or plans
  - Whenever you're uncertain about what to do next
  - After completing tasks to update your understanding of remaining work
  - After every few messages to ensure you're on track

  Usage:
  - This tool takes in no parameters. So leave the input blank or empty. DO NOT include a dummy object, placeholder string or a key like "input" or "empty". LEAVE IT BLANK.
  - Returns a list of todo items with their status, priority, and content
  - Use this information to track progress and plan next steps
  - If no todos exist yet, an empty list will be returned
`

export function createTodoTools(todos: Map<string, TodoInfo[]>) {
  const todoWrite = tool({
    description: todoWriteDescription,
    inputSchema: z.object({
      todos: z.array(TodoInfo).describe('The updated todo list'),
    }),
    execute: async ({ todos: newTodos }, { abortSignal, toolCallId }) => {
      const sessionId = toolCallId
      todos.set(sessionId, newTodos)
      const incompleteTodos = newTodos.filter(
        (x) => x.status !== 'completed',
      ).length

      return {
        title: `${incompleteTodos} todos`,
        output: JSON.stringify(newTodos, null, 2),
        metadata: {
          todos: newTodos,
        },
      }
    },
  })

  const todoRead = tool({
    description: todoReadDescription,
    inputSchema: z.object({}),
    execute: async ({}, { abortSignal, toolCallId }) => {
      const sessionId = toolCallId
      const currentTodos = todos.get(sessionId) ?? []
      const incompleteTodos = currentTodos.filter(
        (x) => x.status !== 'completed',
      ).length

      return {
        title: `${incompleteTodos} todos`,
        output: JSON.stringify(currentTodos, null, 2),
        metadata: {
          todos: currentTodos,
        },
      }
    },
  })

  return {
    todowrite: todoWrite,
    todoread: todoRead,
  }
}
