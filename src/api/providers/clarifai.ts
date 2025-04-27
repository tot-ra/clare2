import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandlerOptions, ClarifaiModelId, clarifaiDefaultModelId, clarifaiModels, ModelInfo } from "../../shared/api"
import axios from "axios"
import { BaseProvider } from "./base-provider" // Import BaseProvider
import { ApiStream, ApiStreamChunk } from "../transform/stream"
// Logger and xml2js removed

// Clarifai API handler extending BaseProvider
export class ClarifaiHandler extends BaseProvider { // Extend BaseProvider
	private options: ApiHandlerOptions
	private toolUseIdCounter = 0 // Counter for generating tool_use IDs (kept for potential future use, but not yielded)

	constructor(options: ApiHandlerOptions) {
		super() // Call super constructor (BaseProvider has an implicit one)
		this.options = options
		console.log("ClarifaiHandler initialized") // Replaced Logger
	}

	// Add cacheKey parameter
	createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[], _cacheKey?: string): ApiStream {
		// cacheKey is ignored for now
		return this.stream(systemPrompt, messages, new AbortController().signal)
	}

	getModel(): { id: string; info: ModelInfo } {
		const modelId = (this.options.apiModelId || clarifaiDefaultModelId) as ClarifaiModelId
		const modelInfo = clarifaiModels[modelId] || clarifaiModels[clarifaiDefaultModelId]

		return {
			id: modelId,
			info: modelInfo,
		}
	}

	async *stream(systemPrompt: string, messages: Anthropic.MessageParam[], abortSignal: AbortSignal): ApiStream {
		const pat = this.options.clarifaiPat
		const modelId = this.options.apiModelId

		if (!pat) {
			throw new Error("Clarifai Personal Access Token (PAT) is not configured.")
		}

		if (!modelId) {
			throw new Error("Clarifai Model ID is not configured.")
		}

		console.log(`Clarifai stream called for model: ${modelId}`) // Replaced Logger

		// Extract user_id, app_id, model_name from the modelId
		const modelParts = modelId.split("/")
		if (modelParts.length !== 4 || modelParts[2] !== "models") {
			throw new Error(`Invalid Clarifai Model ID format: ${modelId}. Expected format: user_id/app_id/models/model_name.`)
		}
		const user_id = modelParts[0]
		const app_id = modelParts[1]
		const model_name = modelParts[3]
		// Assuming latest version if not specified in modelId, or if the API handles it
		// const version_id = this.options.clarifaiModelVersionId || "latest" // Use configured version or 'latest'

		const baseUrl = this.options.clarifaiApiBaseUrl || "https://api.clarifai.com"
		const url = `${baseUrl}/v2/users/${user_id}/apps/${app_id}/models/${model_name}/outputs`

		// Format the entire message history as a single text string for the Qwen model.
		// Embed tool calls and results in a text-based format.
		let inputText = ""

		if (systemPrompt) {
			inputText += `System: ${systemPrompt}\n\n` // Include system prompt
		}

		for (const msg of messages) {
			if (msg.role === "user") {
				inputText += `User: `
				if (Array.isArray(msg.content)) {
					inputText += msg.content
						.map((item) => { // Removed incorrect type annotation
							if (item.type === "text") {
								return item.text
							}
							return "" // Ignore other types for now
						})
						.join("\n")
				} else {
					inputText += msg.content
				}
				inputText += "\n\n" // Separator between messages
			} else if (msg.role === "assistant") {
				inputText += `Assistant: `
				if (Array.isArray(msg.content)) {
					inputText += msg.content
						.map((item) => { // Removed incorrect type annotation
							if (item.type === "text") {
								return item.text
							}
							return "" // Ignore other types for now
						})
						.join("\n")
				} else {
					inputText += msg.content
				}
				inputText += "\n\n" // Separator between messages
			}
			// Role 'tool' messages are handled as part of user messages with type 'tool_result'
		}

		const requestBody = {
			inputs: [
				{
					data: {
						text: {
							raw: inputText, // Send the formatted input text
						},
					},
				},
			],
		}

		const headers = {
			Authorization: `Key ${pat}`,
			"Content-Type": "application/json",
		}

		console.log(`Clarifai Request URL: ${url}`) // Replaced Logger
		console.log(`Clarifai Request Headers: ${JSON.stringify(headers)}`) // Replaced Logger
		// console.debug is not standard, using console.log for debug info
		console.log(`Clarifai Request Full Body (Debug): ${JSON.stringify(requestBody)}`) // Replaced Logger
		let requestBodyTxt = JSON.stringify(requestBody)

		// console.log(requestBodyTxt) // Redundant with the debug log above

		try {
			console.log("making request to url " + url)
			const response = await axios.post(url, requestBodyTxt, {
				headers: headers,
				signal: abortSignal,
			})
			console.log("got response")
			console.log(response)

			console.log(`Clarifai Response Status: ${response.status}`) // Replaced Logger
			console.log(`Clarifai Raw Response Data: ${JSON.stringify(response.data, null, 2)}`) // Replaced Logger

			if (response.status === 200 && response.data?.outputs?.length > 0) {
				let fullOutputText = ""
				for (const output of response.data.outputs) {
					if (output?.data?.text?.raw) {
						fullOutputText += output.data.text.raw + "\n"
					}
				}

				if (fullOutputText.length > 0) {
					console.log(`Extracted Full Output Text: ${fullOutputText}`) // Replaced Logger
					yield* this.parseClarifaiOutput(fullOutputText)
				} else {
					console.warn("Clarifai response was successful but contained no text output.") // Replaced Logger
				}
			} else {
				const statusDescription = response.data?.status?.description || "Unknown error"
				const statusCode = response.data?.status?.code || response.status
				console.error(`Clarifai API error: ${statusCode} - ${statusDescription}`) // Replaced Logger
				console.error(`Full response: ${JSON.stringify(response.data)}`) // Replaced Logger
				throw new Error(`Clarifai API error (${statusCode}): ${statusDescription}`)
			}
		} catch (error: any) {
			if (axios.isCancel(error)) {
				console.log("Clarifai request cancelled.") // Replaced Logger
			} else if (axios.isAxiosError(error)) {
				console.error(`Clarifai API request failed: ${error.message}`) // Replaced Logger
				console.error(`Response status: ${error.response?.status}`) // Replaced Logger
				console.error(`Response data: ${JSON.stringify(error.response?.data)}`) // Replaced Logger
				const statusDescription = error.response?.data?.status?.description || error.message
				const statusCode = error.response?.data?.status?.code || error.response?.status || "Network Error"
				throw new Error(`Clarifai API error (${statusCode}): ${statusDescription}`)
			} else {
				console.error(`Clarifai stream error: ${error}`) // Replaced Logger
				throw new Error(`Clarifai stream error: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
	}

	// Updated return type to match clare2's ApiStreamChunk definition
	private async *parseClarifaiOutput(outputText: string): AsyncGenerator<ApiStreamChunk, void, unknown> {
		// Regex to find blocks like <tag>...</tag> or tool_code/tool_result blocks
		// Refined regex to be more robust to whitespace and optional language identifiers
		// Note: tool_code and tool_result will be yielded as plain text due to clare2's ApiStreamChunk types
		const blockRegex =
			/<(task|environment_details|thinking)>(.*?)<\/\1>|tool_code\s*```(?:\w+)?\s*\n(.*?)\s*```|tool_result\s*```(?:\w+)?\s*\n(.*?)\s*```/gs
		let lastIndex = 0
		let match

		while ((match = blockRegex.exec(outputText)) !== null) {
			const fullMatch = match[0]
			const tag = match[1] // For <tag>...</tag>
			const tagContent = match[2] // Content for <tag>...</tag>
			const toolCodeContent = match[3] // Content for tool_code block
			const toolResultContent = match[4] // Content for tool_result block
			const startIndex = match.index

			if (startIndex > lastIndex) {
				yield { type: "text", text: outputText.substring(lastIndex, startIndex) }
			}

			if (tag) {
				// Handle <task>, <environment_details>, <thinking> tags
				switch (tag) {
					case "task":
					case "environment_details":
					case "thinking": // Map <thinking> to 'reasoning' chunk type
						yield { type: "reasoning", text: tagContent.trim() }
						break
					default: // Other tags like <task>, <environment_details> remain as text
						yield { type: "text", text: fullMatch }
						break
				}
			} else if (toolCodeContent !== undefined) {
				// Handle tool_code block - yield as plain text
				yield { type: "text", text: fullMatch }
				// Original parsing logic commented out as 'tool_use' type is not supported
				// try {
				// 	const toolCall = JSON.parse(toolCodeContent.trim())
				// 	const toolName = toolCall.tool_name
				// 	const toolContent = JSON.stringify(toolCall.parameters)
				// 	const toolUseId = `tool_use_${this.toolUseIdCounter++}` // Generate a unique ID
				// 	yield { type: "tool_use", name: toolName, content: toolContent, id: toolUseId }
				// } catch (e: any) {
				// 	console.error(`Failed to parse tool_code JSON content: ${toolCodeContent}`, e) // Replaced Logger
				// 	yield { type: "text", text: fullMatch } // Yield as text if parsing fails
				// }
			} else if (toolResultContent !== undefined) {
				// Handle tool_result block - yield as plain text
				yield { type: "text", text: fullMatch }
			}

			lastIndex = blockRegex.lastIndex
		}

		if (lastIndex < outputText.length) {
			yield { type: "text", text: outputText.substring(lastIndex) }
		}
	}

	// listAvailableModels method removed as it's not part of clare2's ApiHandler interface
}
