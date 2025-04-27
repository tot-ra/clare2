import * as path from "path"
import fs from "fs/promises"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import { ClineProvider } from "./ClineProvider"
import { Language, ApiConfigMeta } from "../../schemas"
import { changeLanguage, t } from "../../i18n"
import { ApiConfiguration } from "../../shared/api"
import { supportPrompt } from "../../shared/support-prompt"

import { checkoutDiffPayloadSchema, checkoutRestorePayloadSchema, WebviewMessage } from "../../shared/WebviewMessage"
import { checkExistKey } from "../../shared/checkExistApiConfig"
import { experimentDefault } from "../../shared/experiments"
import { Terminal } from "../../integrations/terminal/Terminal"
import { openFile, openImage } from "../../integrations/misc/open-file"
import { selectImages } from "../../integrations/misc/process-images"
import { getTheme } from "../../integrations/theme/getTheme"
import { discoverChromeHostUrl, tryChromeHostUrl } from "../../services/browser/browserDiscovery"
import { searchWorkspaceFiles } from "../../services/search/file-search"
import { fileExistsAtPath } from "../../utils/fs"
import { playSound, setSoundEnabled, setSoundVolume } from "../../utils/sound"
import { playTts, setTtsEnabled, setTtsSpeed, stopTts } from "../../utils/tts"
import { singleCompletionHandler } from "../../utils/single-completion-handler"
import { searchCommits } from "../../utils/git"
import { exportSettings, importSettings } from "../config/importExport"
import { getOpenAiModels } from "../../api/providers/openai"
import { getOllamaModels } from "../../api/providers/ollama"
import { getVsCodeLmModels } from "../../api/providers/vscode-lm"
import { getLmStudioModels } from "../../api/providers/lmstudio"
import { openMention } from "../mentions"
import { telemetryService } from "../../services/telemetry/TelemetryService"
import { TelemetrySetting } from "../../shared/TelemetrySetting"
import { getWorkspacePath } from "../../utils/path"
import { Mode, defaultModeSlug, getModeBySlug, getGroupName } from "../../shared/modes"
import { SYSTEM_PROMPT } from "../prompts/system"
import { buildApiHandler } from "../../api"
import { GlobalState } from "../../schemas"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import { getModels } from "../../api/providers/fetchers/cache"

export const webviewMessageHandler = async (provider: ClineProvider, message: WebviewMessage) => {
	// Utility functions provided for concise get/update of global state via contextProxy API.
	const getGlobalState = <K extends keyof GlobalState>(key: K) => provider.contextProxy.getValue(key)
	const updateGlobalState = async <K extends keyof GlobalState>(key: K, value: GlobalState[K]) =>
		await provider.contextProxy.setValue(key, value)

	switch (message.type) {
		case "webviewDidLaunch":
			// Load custom modes first
			const customModes = await provider.customModesManager.getCustomModes()
			await updateGlobalState("customModes", customModes)

			provider.postStateToWebview()
			provider.workspaceTracker?.initializeFilePaths() // Don't await.

			getTheme().then((theme) => provider.postMessageToWebview({ type: "theme", text: JSON.stringify(theme) }))

			// If MCP Hub is already initialized, update the webview with
			// current server list.
			const mcpHub = provider.getMcpHub()

			if (mcpHub) {
				provider.postMessageToWebview({ type: "mcpServers", mcpServers: mcpHub.getAllServers() })
			}

			provider.providerSettingsManager
				.listConfig()
				.then(async (listApiConfig) => {
					if (!listApiConfig) {
						return
					}

					if (listApiConfig.length === 1) {
						// Check if first time init then sync with exist config.
						if (!checkExistKey(listApiConfig[0])) {
							const { apiConfiguration } = await provider.getState()

							await provider.providerSettingsManager.saveConfig(
								listApiConfig[0].name ?? "default",
								apiConfiguration,
							)

							listApiConfig[0].apiProvider = apiConfiguration.apiProvider
						}
					}

					const currentConfigName = getGlobalState("currentApiConfigName")

					if (currentConfigName) {
						if (!(await provider.providerSettingsManager.hasConfig(currentConfigName))) {
							// current config name not valid, get first config in list
							await updateGlobalState("currentApiConfigName", listApiConfig?.[0]?.name)
							if (listApiConfig?.[0]?.name) {
								const apiConfig = await provider.providerSettingsManager.loadConfig(
									listApiConfig?.[0]?.name,
								)

								await Promise.all([
									updateGlobalState("listApiConfigMeta", listApiConfig),
									provider.postMessageToWebview({ type: "listApiConfig", listApiConfig }),
									provider.updateApiConfiguration(apiConfig),
								])
								await provider.postStateToWebview()
								return
							}
						}
					}

					await Promise.all([
						await updateGlobalState("listApiConfigMeta", listApiConfig),
						await provider.postMessageToWebview({ type: "listApiConfig", listApiConfig }),
					])
				})
				.catch((error) =>
					provider.log(
						`Error list api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					),
				)

			// If user already opted in to telemetry, enable telemetry service
			provider.getStateToPostToWebview().then((state) => {
				const { telemetrySetting } = state
				const isOptedIn = telemetrySetting === "enabled"
				telemetryService.updateTelemetryState(isOptedIn)
			})

			provider.isViewLaunched = true
			break
		case "newTask":
			// Code that should run in response to the hello message command
			//vscode.window.showInformationMessage(message.text!)

			// Send a message to our webview.
			// You can send any JSON serializable data.
			// Could also do this in extension .ts
			//provider.postMessageToWebview({ type: "text", text: `Extension: ${Date.now()}` })
			// initializing new instance of Cline will make sure that any agentically running promises in old instance don't affect our new task. this essentially creates a fresh slate for the new task
			await provider.initClineWithTask(message.text, message.images)
			break
		case "apiConfiguration":
			if (message.apiConfiguration) {
				await provider.updateApiConfiguration(message.apiConfiguration)
			}
			await provider.postStateToWebview()
			break
		case "customInstructions":
			await provider.updateCustomInstructions(message.text)
			break
		case "alwaysAllowReadOnly":
			await updateGlobalState("alwaysAllowReadOnly", message.bool ?? undefined)
			await provider.postStateToWebview()
			break
		case "alwaysAllowReadOnlyOutsideWorkspace":
			await updateGlobalState("alwaysAllowReadOnlyOutsideWorkspace", message.bool ?? undefined)
			await provider.postStateToWebview()
			break
		case "alwaysAllowWrite":
			await updateGlobalState("alwaysAllowWrite", message.bool ?? undefined)
			await provider.postStateToWebview()
			break
		case "alwaysAllowWriteOutsideWorkspace":
			await updateGlobalState("alwaysAllowWriteOutsideWorkspace", message.bool ?? undefined)
			await provider.postStateToWebview()
			break
		case "alwaysAllowExecute":
			await updateGlobalState("alwaysAllowExecute", message.bool ?? undefined)
			await provider.postStateToWebview()
			break
		case "alwaysAllowBrowser":
			await updateGlobalState("alwaysAllowBrowser", message.bool ?? undefined)
			await provider.postStateToWebview()
			break
		case "alwaysAllowMcp":
			await updateGlobalState("alwaysAllowMcp", message.bool)
			await provider.postStateToWebview()
			break
		case "alwaysAllowModeSwitch":
			await updateGlobalState("alwaysAllowModeSwitch", message.bool)
			await provider.postStateToWebview()
			break
		case "alwaysAllowSubtasks":
			await updateGlobalState("alwaysAllowSubtasks", message.bool)
			await provider.postStateToWebview()
			break
		case "askResponse":
			provider.getCurrentCline()?.handleWebviewAskResponse(message.askResponse!, message.text, message.images)
			break
		case "clearTask":
			// clear task resets the current session and allows for a new task to be started, if this session is a subtask - it allows the parent task to be resumed
			await provider.finishSubTask(t("common:tasks.canceled"))
			await provider.postStateToWebview()
			break
		case "didShowAnnouncement":
			await updateGlobalState("lastShownAnnouncementId", provider.latestAnnouncementId)
			await provider.postStateToWebview()
			break
		case "selectImages":
			const images = await selectImages()
			await provider.postMessageToWebview({ type: "selectedImages", images })
			break
		case "exportCurrentTask":
			const currentTaskId = provider.getCurrentCline()?.taskId
			if (currentTaskId) {
				provider.exportTaskWithId(currentTaskId)
			}
			break
		case "showTaskWithId":
			provider.showTaskWithId(message.text!)
			break
		case "deleteTaskWithId":
			provider.deleteTaskWithId(message.text!)
			break
		case "deleteMultipleTasksWithIds": {
			const ids = message.ids

			if (Array.isArray(ids)) {
				// Process in batches of 20 (or another reasonable number)
				const batchSize = 20
				const results = []

				// Only log start and end of the operation
				console.log(`Batch deletion started: ${ids.length} tasks total`)

				for (let i = 0; i < ids.length; i += batchSize) {
					const batch = ids.slice(i, i + batchSize)

					const batchPromises = batch.map(async (id) => {
						try {
							await provider.deleteTaskWithId(id)
							return { id, success: true }
						} catch (error) {
							// Keep error logging for debugging purposes
							console.log(
								`Failed to delete task ${id}: ${error instanceof Error ? error.message : String(error)}`,
							)
							return { id, success: false }
						}
					})

					// Process each batch in parallel but wait for completion before starting the next batch
					const batchResults = await Promise.all(batchPromises)
					results.push(...batchResults)

					// Update the UI after each batch to show progress
					await provider.postStateToWebview()
				}

				// Log final results
				const successCount = results.filter((r) => r.success).length
				const failCount = results.length - successCount
				console.log(
					`Batch deletion completed: ${successCount}/${ids.length} tasks successful, ${failCount} tasks failed`,
				)
			}
			break
		}
		case "exportTaskWithId":
			provider.exportTaskWithId(message.text!)
			break
		case "importSettings":
			const { success } = await importSettings({
				providerSettingsManager: provider.providerSettingsManager,
				contextProxy: provider.contextProxy,
				customModesManager: provider.customModesManager,
			})

			if (success) {
				provider.settingsImportedAt = Date.now()
				await provider.postStateToWebview()
				await vscode.window.showInformationMessage(t("common:info.settings_imported"))
			}

			break
		case "exportSettings":
			await exportSettings({
				providerSettingsManager: provider.providerSettingsManager,
				contextProxy: provider.contextProxy,
			})

			break
		case "resetState":
			await provider.resetState()
			break
		case "requestRouterModels":
			const [openRouterModels, requestyModels, glamaModels, unboundModels] = await Promise.all([
				getModels("openrouter"),
				getModels("requesty"),
				getModels("glama"),
				getModels("unbound"),
			])

			provider.postMessageToWebview({
				type: "routerModels",
				routerModels: {
					openrouter: openRouterModels,
					requesty: requestyModels,
					glama: glamaModels,
					unbound: unboundModels,
				},
			})
			break
		case "requestOpenAiModels":
			if (message?.values?.baseUrl && message?.values?.apiKey) {
				const openAiModels = await getOpenAiModels(
					message?.values?.baseUrl,
					message?.values?.apiKey,
					message?.values?.hostHeader,
				)

				provider.postMessageToWebview({ type: "openAiModels", openAiModels })
			}

			break
		case "requestOllamaModels":
			const ollamaModels = await getOllamaModels(message.text)
			// TODO: Cache like we do for OpenRouter, etc?
			provider.postMessageToWebview({ type: "ollamaModels", ollamaModels })
			break
		case "requestLmStudioModels":
			const lmStudioModels = await getLmStudioModels(message.text)
			// TODO: Cache like we do for OpenRouter, etc?
			provider.postMessageToWebview({ type: "lmStudioModels", lmStudioModels })
			break
		case "requestVsCodeLmModels":
			const vsCodeLmModels = await getVsCodeLmModels()
			// TODO: Cache like we do for OpenRouter, etc?
			provider.postMessageToWebview({ type: "vsCodeLmModels", vsCodeLmModels })
			break
		case "openImage":
			openImage(message.text!)
			break
		case "openFile":
			openFile(message.text!, message.values as { create?: boolean; content?: string })
			break
		case "openMention":
			openMention(message.text)
			break
		case "checkpointDiff":
			const result = checkoutDiffPayloadSchema.safeParse(message.payload)

			if (result.success) {
				await provider.getCurrentCline()?.checkpointDiff(result.data)
			}

			break
		case "checkpointRestore": {
			const result = checkoutRestorePayloadSchema.safeParse(message.payload)

			if (result.success) {
				await provider.cancelTask()

				try {
					await pWaitFor(() => provider.getCurrentCline()?.isInitialized === true, { timeout: 3_000 })
				} catch (error) {
					vscode.window.showErrorMessage(t("common:errors.checkpoint_timeout"))
				}

				try {
					await provider.getCurrentCline()?.checkpointRestore(result.data)
				} catch (error) {
					vscode.window.showErrorMessage(t("common:errors.checkpoint_failed"))
				}
			}

			break
		}
		case "cancelTask":
			await provider.cancelTask()
			break
		case "allowedCommands":
			await provider.context.globalState.update("allowedCommands", message.commands)
			// Also update workspace settings
			await vscode.workspace
				.getConfiguration("roo-cline")
				.update("allowedCommands", message.commands, vscode.ConfigurationTarget.Global)
			break
		case "openMcpSettings": {
			const mcpSettingsFilePath = await provider.getMcpHub()?.getMcpSettingsFilePath()
			if (mcpSettingsFilePath) {
				openFile(mcpSettingsFilePath)
			}
			break
		}
		case "openProjectMcpSettings": {
			if (!vscode.workspace.workspaceFolders?.length) {
				vscode.window.showErrorMessage(t("common:errors.no_workspace"))
				return
			}

			const workspaceFolder = vscode.workspace.workspaceFolders[0]
			const rooDir = path.join(workspaceFolder.uri.fsPath, ".roo")
			const mcpPath = path.join(rooDir, "mcp.json")

			try {
				await fs.mkdir(rooDir, { recursive: true })
				const exists = await fileExistsAtPath(mcpPath)
				if (!exists) {
					await fs.writeFile(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2))
				}
				await openFile(mcpPath)
			} catch (error) {
				vscode.window.showErrorMessage(t("common:errors.create_mcp_json", { error: `${error}` }))
			}
			break
		}
		case "openCustomModesSettings": {
			const customModesFilePath = await provider.customModesManager.getCustomModesFilePath()
			if (customModesFilePath) {
				openFile(customModesFilePath)
			}
			break
		}
		case "deleteMcpServer": {
			if (!message.serverName) {
				break
			}

			try {
				provider.log(`Attempting to delete MCP server: ${message.serverName}`)
				await provider.getMcpHub()?.deleteServer(message.serverName, message.source as "global" | "project")
				provider.log(`Successfully deleted MCP server: ${message.serverName}`)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Failed to delete MCP server: ${errorMessage}`)
				// Error messages are already handled by McpHub.deleteServer
			}
			break
		}
		case "restartMcpServer": {
			try {
				await provider.getMcpHub()?.restartConnection(message.text!, message.source as "global" | "project")
			} catch (error) {
				provider.log(
					`Failed to retry connection for ${message.text}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}
			break
		}
		case "toggleToolAlwaysAllow": {
			try {
				await provider
					.getMcpHub()
					?.toggleToolAlwaysAllow(
						message.serverName!,
						message.source as "global" | "project",
						message.toolName!,
						Boolean(message.alwaysAllow),
					)
			} catch (error) {
				provider.log(
					`Failed to toggle auto-approve for tool ${message.toolName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}
			break
		}
		case "toggleMcpServer": {
			try {
				await provider
					.getMcpHub()
					?.toggleServerDisabled(
						message.serverName!,
						message.disabled!,
						message.source as "global" | "project",
					)
			} catch (error) {
				provider.log(
					`Failed to toggle MCP server ${message.serverName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}
			break
		}
		case "mcpEnabled":
			const mcpEnabled = message.bool ?? true
			await updateGlobalState("mcpEnabled", mcpEnabled)
			await provider.postStateToWebview()
			break
		case "enableMcpServerCreation":
			await updateGlobalState("enableMcpServerCreation", message.bool ?? true)
			await provider.postStateToWebview()
			break
		case "playSound":
			if (message.audioType) {
				const soundPath = path.join(provider.context.extensionPath, "audio", `${message.audioType}.wav`)
				playSound(soundPath)
			}
			break
		case "soundEnabled":
			const soundEnabled = message.bool ?? true
			await updateGlobalState("soundEnabled", soundEnabled)
			setSoundEnabled(soundEnabled) // Add this line to update the sound utility
			await provider.postStateToWebview()
			break
		case "soundVolume":
			const soundVolume = message.value ?? 0.5
			await updateGlobalState("soundVolume", soundVolume)
			setSoundVolume(soundVolume)
			break
		case "ttsEnabled":
			const ttsEnabled = message.bool ?? true
			await updateGlobalState("ttsEnabled", ttsEnabled)
			setTtsEnabled(ttsEnabled)
			await provider.postStateToWebview()
			break
		case "ttsSpeed":
			const ttsSpeed = message.value ?? 1.0
			await updateGlobalState("ttsSpeed", ttsSpeed)
			setTtsSpeed(ttsSpeed)
			await provider.postStateToWebview()
			break
		case "playTts":
			if (message.text) {
				playTts(message.text)
			}
			break
		case "stopTts":
			stopTts()
			break
		case "diffEnabled":
			await updateGlobalState("diffEnabled", message.bool ?? true)
			await provider.postStateToWebview()
			break
		case "enableCheckpoints":
			await updateGlobalState("enableCheckpoints", message.bool ?? true)
			await provider.postStateToWebview()
			break
		case "browserViewportSize":
			await updateGlobalState("browserViewportSize", message.text)
			await provider.postStateToWebview()
			break
		case "remoteBrowserHost":
			await updateGlobalState("remoteBrowserHost", message.text)
			await provider.postStateToWebview()
			break
		case "remoteBrowserEnabled":
			const remoteBrowserEnabled = message.bool ?? true
			await updateGlobalState("remoteBrowserEnabled", remoteBrowserEnabled)
			await provider.postStateToWebview()
			break
		case "testBrowserConnection":
			if (message.text) {
				try {
					const success = await tryChromeHostUrl(message.text)
					provider.postMessageToWebview({ type: "testBrowserConnectionResult", success })
				} catch (error) {
					console.error("Error testing browser connection:", error)
					provider.postMessageToWebview({ type: "testBrowserConnectionResult", success: false })
				}
			} else {
				// If no host provided, try to discover
				try {
					const discoveredHost = await discoverChromeHostUrl()
					if (discoveredHost) {
						const success = await tryChromeHostUrl(discoveredHost)
						provider.postMessageToWebview({ type: "testBrowserConnectionResult", success, host: discoveredHost })
					} else {
						provider.postMessageToWebview({ type: "testBrowserConnectionResult", success: false })
					}
				} catch (error) {
					console.error("Error discovering browser host:", error)
					provider.postMessageToWebview({ type: "testBrowserConnectionResult", success: false })
				}
			}
			break
		case "fuzzyMatchThreshold":
			await updateGlobalState("fuzzyMatchThreshold", message.value ?? 0.5)
			await provider.postStateToWebview()
			break
		case "alwaysApproveResubmit":
			await updateGlobalState("alwaysApproveResubmit", message.bool ?? false)
			await provider.postStateToWebview()
			break
		case "requestDelaySeconds":
			await updateGlobalState("requestDelaySeconds", message.value ?? 0)
			await provider.postStateToWebview()
			break
		case "writeDelayMs":
			await updateGlobalState("writeDelayMs", message.value ?? 0)
			await provider.postStateToWebview()
			break
		case "terminalOutputLineLimit":
			await updateGlobalState("terminalOutputLineLimit", message.value ?? 1000)
			await provider.postStateToWebview()
			break
		case "terminalShellIntegrationTimeout":
			await updateGlobalState("terminalShellIntegrationTimeout", message.value ?? 5000)
			await provider.postStateToWebview()
			break
		case "terminalCommandDelay":
			await updateGlobalState("terminalCommandDelay", message.value ?? 100)
			await provider.postStateToWebview()
			break
		case "terminalPowershellCounter":
			await updateGlobalState("terminalPowershellCounter", message.value ?? 0)
			await provider.postStateToWebview()
			break
		case "terminalZshClearEolMark":
			await updateGlobalState("terminalZshClearEolMark", message.bool ?? false)
			await provider.postStateToWebview()
			break
		case "terminalZshOhMy":
			await updateGlobalState("terminalZshOhMy", message.bool ?? false)
			await provider.postStateToWebview()
			break
		case "terminalZshP10k":
			await updateGlobalState("terminalZshP10k", message.bool ?? false)
			await provider.postStateToWebview()
			break
		case "terminalZdotdir":
			await updateGlobalState("terminalZdotdir", message.text)
			await provider.postStateToWebview()
			break
		case "terminalCompressProgressBar":
			await updateGlobalState("terminalCompressProgressBar", message.bool ?? false)
			await provider.postStateToWebview()
			break
		case "updateSupportPrompt":
			if (message.text) {
				await updateGlobalState("supportPrompt", supportPrompt(message.text))
				await provider.postStateToWebview()
			}
			break
		case "resetSupportPrompt":
			await updateGlobalState("supportPrompt", undefined)
			await provider.postStateToWebview()
			break
		case "updatePrompt":
			if (message.text) {
				await updateGlobalState("prompt", message.text)
				await provider.postStateToWebview()
			}
			break
		case "deleteMessage": {
			const { taskId, messageId } = message
			if (taskId && messageId) {
				const task = provider.getTask(taskId)
				if (task) {
					task.deleteMessage(messageId)
					await provider.postStateToWebview()
				}
			}
			break
		}
		case "screenshotQuality":
			await updateGlobalState("screenshotQuality", message.value ?? 0.5)
			await provider.postStateToWebview()
			break
		case "maxOpenTabsContext":
			await updateGlobalState("maxOpenTabsContext", message.value ?? 10)
			await provider.postStateToWebview()
			break
		case "maxWorkspaceFiles":
			await updateGlobalState("maxWorkspaceFiles", message.value ?? 1000)
			await provider.postStateToWebview()
			break
		case "browserToolEnabled":
			await updateGlobalState("browserToolEnabled", message.bool ?? true)
			await provider.postStateToWebview()
			break
		case "language":
			if (message.text) {
				await updateGlobalState("language", message.text as Language)
				changeLanguage(message.text as Language)
				await provider.postStateToWebview()
			}
			break
		case "showRooIgnoredFiles":
			await updateGlobalState("showRooIgnoredFiles", message.bool ?? false)
			await provider.postStateToWebview()
			break
		case "maxReadFileLine":
			await updateGlobalState("maxReadFileLine", message.value ?? 1000)
			await provider.postStateToWebview()
			break
		case "setHistoryPreviewCollapsed": // Add the new case handler
			if (message.text) {
				const collapsedHistoryPreviews = new Set(getGlobalState("collapsedHistoryPreviews"))
				if (message.bool) {
					collapsedHistoryPreviews.add(message.text)
				} else {
					collapsedHistoryPreviews.delete(message.text)
				}
				await updateGlobalState("collapsedHistoryPreviews", Array.from(collapsedHistoryPreviews))
				await provider.postStateToWebview()
			}
			break
		case "toggleApiConfigPin":
			if (message.text) {
				const pinnedApiConfigs = new Set(getGlobalState("pinnedApiConfigs"))
				if (pinnedApiConfigs.has(message.text)) {
					pinnedApiConfigs.delete(message.text)
				} else {
					pinnedApiConfigs.add(message.text)
				}
				await updateGlobalState("pinnedApiConfigs", Array.from(pinnedApiConfigs))
				await provider.postStateToWebview()
			}
			break
		case "enhancementApiConfigId":
			await updateGlobalState("enhancementApiConfigId", message.text)
			await provider.postStateToWebview()
			break
		case "autoApprovalEnabled":
			await updateGlobalState("autoApprovalEnabled", message.bool ?? false)
			await provider.postStateToWebview()
			break
		case "enhancePrompt":
			if (message.text) {
				const currentCline = provider.getCurrentCline()
				if (currentCline) {
					await singleCompletionHandler(currentCline, message.text)
				}
			}
			break
		case "getSystemPrompt":
			const systemPrompt = await generateSystemPrompt(provider, message)
			provider.postMessageToWebview({ type: "systemPrompt", text: systemPrompt })
			break
		case "copySystemPrompt":
			const systemPromptToCopy = await generateSystemPrompt(provider, message)
			await vscode.env.clipboard.writeText(systemPromptToCopy)
			vscode.window.showInformationMessage(t("common:info.system_prompt_copied"))
			break
		case "searchCommits": {
			const commits = await searchCommits(message.text)
			provider.postMessageToWebview({ type: "searchCommitsResult", commits })
			break
		}
		case "searchFiles": {
			const results = await searchWorkspaceFiles(message.text)
			provider.postMessageToWebview({ type: "searchFilesResult", results })
			break
		}
		case "saveClarifaiSettings":
			if (message.values) {
				// This case seems to be for saving PAT and Base URL, not models
				// The frontend should handle saving these via the main apiConfiguration message
				console.warn("Received saveClarifaiSettings message, but this should be handled by apiConfiguration.")
				provider.postMessageToWebview({ type: "clarifaiSettingsSaved", success: false, error: "Deprecated message type." });
			} else {
				provider.postMessageToWebview({ type: "clarifaiSettingsSaved", success: false, error: "Missing values." });
			}
			break;
		case "saveApiConfiguration":
			if (message.apiConfiguration) {
				try {
					await provider.providerSettingsManager.saveConfig(
						message.apiConfiguration.name ?? "default",
						message.apiConfiguration,
					)
					await provider.postStateToWebview()
					provider.postMessageToWebview({ type: "apiConfigurationSaved", success: true })
				} catch (error) {
					console.error("Error saving API configuration:", error)
					provider.postMessageToWebview({
						type: "apiConfigurationSaved",
						success: false,
						error: error instanceof Error ? error.message : String(error),
					})
				}
			} else {
				provider.postMessageToWebview({ type: "apiConfigurationSaved", success: false, error: "Missing configuration." })
			}
			break
		case "upsertApiConfiguration":
			if (message.apiConfiguration) {
				try {
					await provider.providerSettingsManager.upsertConfig(message.apiConfiguration)
					await provider.postStateToWebview()
					provider.postMessageToWebview({ type: "apiConfigurationUpserted", success: true })
				} catch (error) {
					console.error("Error upserting API configuration:", error)
					provider.postMessageToWebview({
						type: "apiConfigurationUpserted",
						success: false,
						error: error instanceof Error ? error.message : String(error),
					})
				}
			} else {
				provider.postMessageToWebview({ type: "apiConfigurationUpserted", success: false, error: "Missing configuration." })
			}
			break
		case "renameApiConfiguration":
			if (message.oldName && message.newName) {
				try {
					await provider.providerSettingsManager.renameConfig(message.oldName, message.newName)
					await provider.postStateToWebview()
					provider.postMessageToWebview({ type: "apiConfigurationRenamed", success: true })
				} catch (error) {
					console.error("Error renaming API configuration:", error)
					provider.postMessageToWebview({
						type: "apiConfigurationRenamed",
						success: false,
						error: error instanceof Error ? error.message : String(error),
					})
				}
			} else {
				provider.postMessageToWebview({ type: "apiConfigurationRenamed", success: false, error: "Missing old or new name." })
			}
			break
		case "loadApiConfiguration":
			if (message.text) {
				try {
					const apiConfig = await provider.providerSettingsManager.loadConfig(message.text)
					await provider.updateApiConfiguration(apiConfig)
					await updateGlobalState("currentApiConfigName", message.text)
					await provider.postStateToWebview()
					provider.postMessageToWebview({ type: "apiConfigurationLoaded", success: true })
				} catch (error) {
					console.error("Error loading API configuration:", error)
					provider.postMessageToWebview({
						type: "apiConfigurationLoaded",
						success: false,
						error: error instanceof Error ? error.message : String(error),
					})
				}
			} else {
				provider.postMessageToWebview({ type: "apiConfigurationLoaded", success: false, error: "Missing configuration name." })
			}
			break
		case "loadApiConfigurationById":
			if (message.text) {
				try {
					const apiConfig = await provider.providerSettingsManager.loadConfigById(message.text)
					await provider.updateApiConfiguration(apiConfig)
					await updateGlobalState("currentApiConfigName", apiConfig.name)
					await provider.postStateToWebview()
					provider.postMessageToWebview({ type: "apiConfigurationLoaded", success: true })
				} catch (error) {
					console.error("Error loading API configuration by ID:", error)
					provider.postMessageToWebview({
						type: "apiConfigurationLoaded",
						success: false,
						error: error instanceof Error ? error.message : String(error),
					})
				}
			} else {
				provider.postMessageToWebview({ type: "apiConfigurationLoaded", success: false, error: "Missing configuration ID." })
			}
			break
		case "deleteApiConfiguration":
			if (message.text) {
				try {
					await provider.providerSettingsManager.deleteConfig(message.text)
					// After deleting, load the first config in the list if available
					const remainingConfigs = await provider.providerSettingsManager.listConfig()
					if (remainingConfigs && remainingConfigs.length > 0) {
						const firstConfig = remainingConfigs[0]
						const apiConfig = await provider.providerSettingsManager.loadConfig(firstConfig.name)
						await provider.updateApiConfiguration(apiConfig)
						await updateGlobalState("currentApiConfigName", firstConfig.name)
					} else {
						// If no configs left, reset to default empty state
						await provider.updateApiConfiguration({})
						await updateGlobalState("currentApiConfigName", undefined)
					}
					await provider.postStateToWebview()
					provider.postMessageToWebview({ type: "apiConfigurationDeleted", success: true })
				} catch (error) {
					console.error("Error deleting API configuration:", error)
					provider.postMessageToWebview({
						type: "apiConfigurationDeleted",
						success: false,
						error: error instanceof Error ? error.message : String(error),
					})
				}
			} else {
				provider.postMessageToWebview({ type: "apiConfigurationDeleted", success: false, error: "Missing configuration name." })
			}
			break
		case "getListApiConfiguration":
			try {
				const listApiConfig = await provider.providerSettingsManager.listConfig()
				await updateGlobalState("listApiConfigMeta", listApiConfig)
				provider.postMessageToWebview({ type: "listApiConfig", listApiConfig })
			} catch (error) {
				console.error("Error listing API configurations:", error)
				provider.postMessageToWebview({
					type: "listApiConfig",
					listApiConfig: [],
					error: error instanceof Error ? error.message : String(error),
				})
			}
			break
		case "updateExperimental": {
			const { key, value } = message
			if (key) {
				const currentExperiments = getGlobalState("experiments") || {}
				const updatedExperiments = {
					...currentExperiments,
					[key]: value,
				}
				await updateGlobalState("experiments", updatedExperiments)
				await provider.postStateToWebview()
			}
			break
		}
		case "updateMcpTimeout":
			if (message.value !== undefined) {
				await updateGlobalState("mcpTimeout", message.value)
				await provider.postStateToWebview()
			}
			break
		case "updateCustomMode":
			if (message.mode) {
				try {
					await provider.customModesManager.upsertCustomMode(message.mode)
					const customModes = await provider.customModesManager.getCustomModes()
					await updateGlobalState("customModes", customModes)
					await provider.postStateToWebview()
					provider.postMessageToWebview({ type: "customModeUpserted", success: true })
				} catch (error) {
					console.error("Error upserting custom mode:", error)
					provider.postMessageToWebview({
						type: "customModeUpserted",
						success: false,
						error: error instanceof Error ? error.message : String(error),
					})
				}
			} else {
				provider.postMessageToWebview({ type: "customModeUpserted", success: false, error: "Missing mode data." })
			}
			break
		case "deleteCustomMode":
			if (message.text) {
				try {
					await provider.customModesManager.deleteCustomMode(message.text)
					const customModes = await provider.customModesManager.getCustomModes()
					await updateGlobalState("customModes", customModes)
					await provider.postStateToWebview()
					provider.postMessageToWebview({ type: "customModeDeleted", success: true })
				} catch (error) {
					console.error("Error deleting custom mode:", error)
					provider.postMessageToWebview({
						type: "customModeDeleted",
						success: false,
						error: error instanceof Error ? error.message : String(error),
					})
				}
			} else {
				provider.postMessageToWebview({ type: "customModeDeleted", success: false, error: "Missing mode slug." })
			}
			break
		case "humanRelayResponse":
			if (message.response) {
				provider.getCurrentCline()?.handleHumanRelayResponse(message.response)
			}
			break
		case "humanRelayCancel":
			provider.getCurrentCline()?.cancelHumanRelay()
			break
		case "telemetrySetting": {
			const setting = message.value
			if (setting !== undefined) {
				await updateGlobalState("telemetrySetting", setting)
				const isOptedIn = setting === "enabled"
				telemetryService.updateTelemetryState(isOptedIn)
				await provider.postStateToWebview()
			}
			break
		}
	}
}

const generateSystemPrompt = async (provider: ClineProvider, message: WebviewMessage) => {
	const {
		apiConfiguration,
		customModePrompts,
		customInstructions,
		browserViewportSize,
		diffEnabled,
		mcpEnabled,
		fuzzyMatchThreshold,
		experiments,
		enableMcpServerCreation,
		browserToolEnabled,
		language,
	} = await provider.getState()

	const diffStrategy = new MultiSearchReplaceDiffStrategy(fuzzyMatchThreshold)

	const cwd = provider.cwd

	const mode = message.mode ?? defaultModeSlug
	const customModes = await provider.customModesManager.getCustomModes()

	const rooIgnoreInstructions = provider.getCurrentCline()?.rooIgnoreController?.getInstructions()

	// Determine if browser tools can be used based on model support, mode, and user settings
	let modelSupportsComputerUse = false

	// Create a temporary API handler to check if the model supports computer use
	// This avoids relying on an active Cline instance which might not exist during preview
	try {
		const tempApiHandler = buildApiHandler(apiConfiguration)
		modelSupportsComputerUse = tempApiHandler.getModel().info.supportsComputerUse ?? false
	} catch (error) {
		console.error("Error checking if model supports computer use:", error)
	}

	// Check if the current mode includes the browser tool group
	const modeConfig = getModeBySlug(mode, customModes)
	const modeSupportsBrowser = modeConfig?.groups.some((group) => getGroupName(group) === "browser") ?? false

	// Only enable browser tools if the model supports it, the mode includes browser tools,
	// and browser tools are enabled in settings
	const canUseBrowserTool = modelSupportsComputerUse && modeSupportsBrowser && (browserToolEnabled ?? true)

	const systemPrompt = await SYSTEM_PROMPT(
		provider.context,
		cwd,
		canUseBrowserTool,
		mcpEnabled ? provider.getMcpHub() : undefined,
		diffStrategy,
		browserViewportSize ?? "900x600",
		mode,
		customModePrompts,
		customModes,
		customInstructions,
		diffEnabled,
		experiments,
		enableMcpServerCreation,
		language,
		rooIgnoreInstructions,
	)

	return systemPrompt
}
