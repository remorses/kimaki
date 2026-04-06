// Thin re-export shim for backward compatibility.
// Logic lives in:
//   - session-handler/thread-session-runtime.ts (runtime class + registry)
//   - session-handler/thread-runtime-state.ts (state transitions)
//   - session-handler/model-utils.ts (getDefaultModel, types)
//   - session-handler/agent-utils.ts (resolveValidatedAgentPreference)
// New code should import from the specific module directly.

export type { QueuedMessage } from './session-handler/thread-runtime-state.js'
export {
  getDefaultModel,
  type DefaultModelSource,
  type SessionStartSourceContext,
} from './session-handler/model-utils.js'
export { resolveValidatedAgentPreference } from './session-handler/agent-utils.js'
