import { goalPolicyDefaults, resolveOptions } from "./options.ts"
import { handleGoalCommand } from "./command.ts"
import { clearGoalSessionTitle, notifyGoalStatusChange, updateGoalSessionTitle } from "./notify.ts"
import { compactionContext, goalSystemBlock } from "./prompt.ts"
import { GoalRuntime } from "./runtime.ts"
import { GoalStore } from "./store.ts"
import { buildTools, loadToolFactory } from "./tools.ts"
import type { GoalPluginOptions, Hooks, PluginInput } from "./types.ts"

export async function OpenCodeGoalPlugin(input: PluginInput = {}, pluginOptions: GoalPluginOptions = {}): Promise<Hooks> {
  const options = resolveOptions(pluginOptions, input.directory ?? process.cwd())
  const store = new GoalStore(
    options.stateFilePath,
    options.persistState,
    options.toastNotifications || options.sessionTitle
      ? (goal, previousStatus) => {
          if (options.sessionTitle) updateGoalSessionTitle(input.client, goal)
          if (options.toastNotifications) notifyGoalStatusChange(input.client, goal, previousStatus)
        }
      : undefined,
    options.sessionTitle ? (goal) => clearGoalSessionTitle(input.client, goal) : undefined,
    undefined,
    {
      trustRoot: options.stateFileTrustRoot,
      projectLocal: options.stateFileProjectLocal,
    },
    undefined,
    goalPolicyDefaults(options),
  )
  await store.load()
  const runtime = new GoalRuntime(input, store, options)

  const hooks: Hooks = {
    config: async (config) => {
      config.command ??= {}
      config.command[options.commandName] ??= {
        description: "Set a durable session goal.",
        template: "$ARGUMENTS",
      }
    },

    "command.execute.before": async (commandInput, output) => {
      if (commandInput.command !== options.commandName) return
      await runtime.syncSession(commandInput.sessionID)
      await handleGoalCommand({
        sessionID: commandInput.sessionID,
        arguments: commandInput.arguments,
        outputParts: output.parts,
        store,
        options,
      })
    },

    "experimental.chat.system.transform": async (systemInput, output) => {
      if (!systemInput.sessionID) return
      const goal = store.read(systemInput.sessionID)?.goal
      if (!goal || goal.status !== "active") return
      const block = goalSystemBlock(goal, options)
      if (output.system.some((item) => item.includes("<goal_data>"))) return
      output.system = output.system.length > 0 ? [`${output.system[0]}\n\n${block}`, ...output.system.slice(1)] : [block]
    },

    "experimental.session.compacting": async (compactingInput, output) => {
      const goal = store.read(compactingInput.sessionID)?.goal
      if (!goal || (goal.status !== "active" && goal.status !== "paused")) return
      output.context.push(compactionContext(goal, options))
    },

    "experimental.compaction.autocontinue": async (autoInput, output) => {
      const goal = store.read(autoInput.sessionID)?.goal
      if (goal?.status === "active") output.enabled = false
    },

    event: (eventInput) => runtime.handleEvent(eventInput),
  }

  if (options.registerTools) {
    const tool = await loadToolFactory()
    if (tool) hooks.tool = buildTools(tool, store, options)
  }

  return hooks
}

export default OpenCodeGoalPlugin
