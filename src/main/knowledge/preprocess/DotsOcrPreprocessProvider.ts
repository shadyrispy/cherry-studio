import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { fileStorage } from '@main/services/FileStorage'
import { FileMetadata, PreprocessProvider } from '@types'
import AdmZip from 'adm-zip'
import { net } from 'electron'

import BasePreprocessProvider from './BasePreprocessProvider'

const logger = loggerService.withContext('DotsOcrPreprocessProvider')

export default class DotsOcrPreprocessProvider extends BasePreprocessProvider {
	constructor(provider: PreprocessProvider, userId?: string) {
		super(provider, userId)
	}

	public async parseFile(
		sourceId: string,
		file: FileMetadata
	): Promise<{ processedFile: FileMetadata; quota?: number }> {
		try {
			const filePath = fileStorage.getFilePathById(file)
			logger.info(`dots.ocr preprocess started: ${filePath}`)

			await this.validateFile(filePath)
			await this.sendPreprocessProgress(sourceId, 5)

			const endpoint = this.getEndpoint()
			const result = await this.uploadAndParse(endpoint, file, sourceId)

			let processedFile: FileMetadata
			if (result.type === 'zip') {
				const extractDir = await this.downloadAndExtract(result.url!, file)
				processedFile = this.createProcessedFileInfo(file, extractDir)
			} else if (result.type === 'md-url') {
				const mdPath = await this.downloadMarkdown(result.url!, file)
				processedFile = this.createFinalFileInfo(file, mdPath)
			} else if (result.type === 'markdown') {
				const mdPath = await this.writeMarkdownContent(result.content!, file)
				processedFile = this.createFinalFileInfo(file, mdPath)
			} else if (result.type === 'directory') {
				processedFile = this.createProcessedFileInfo(file, result.dir!)
			} else {
				throw new Error('Unsupported response from dots.ocr server')
			}

			await this.sendPreprocessProgress(sourceId, 100)
			return { processedFile }
		} catch (error: any) {
			logger.error(`dots.ocr preprocess failed:`, error as Error)
			throw new Error(error.message || String(error))
		}
	}

	public async checkQuota(): Promise<number> {
		// Local service, no enforced quota
		return -9999
	}

	private async validateFile(filePath: string): Promise<void> {
		const stats = await fs.promises.stat(filePath)
		const fileSizeBytes = stats.size
		if (fileSizeBytes >= 300 * 1024 * 1024) {
			const fileSizeMB = Math.round(fileSizeBytes / (1024 * 1024))
			throw new Error(`PDF file size (${fileSizeMB}MB) exceeds the limit of 300MB`)
		}
	}

	private getEndpoint(): string {
		const apiHost = (this.provider.apiHost || '').replace(/\/$/, '')
		if (!apiHost) {
			throw new Error('dots.ocr server address (apiHost) is not set')
		}
		// Default endpoint path; can be overridden by options.endpoint
		const endpointPath = (this.provider.options?.endpoint as string) || '/parse_file'
		return `${apiHost}${endpointPath}`
	}

	private async uploadAndParse(
		endpoint: string,
		file: FileMetadata,
		sourceId: string
	): Promise<{ type: 'zip' | 'md-url' | 'markdown' | 'directory'; url?: string; content?: string; dir?: string }> {
		const filePath = fileStorage.getFilePathById(file)
		const pdfBuffer = await fs.promises.readFile(filePath)

		// Build multipart form-data
		// Use global FormData/Blob available in Node 22+/Electron fetch
		// @ts-ignore
		const formData = new FormData()
		// @ts-ignore
		const blob = new Blob([pdfBuffer], { type: 'application/pdf' })
		// field name 'file' is a common convention; allow override via options.fileField
		const fileField = (this.provider.options?.fileField as string) || 'file'
		formData.append(fileField, blob, file.origin_name)

		const response = await net.fetch(endpoint, {
			method: 'POST',
			body: formData as any
		})

		if (!response.ok) {
			const text = await response.text()
			throw new Error(`HTTP ${response.status}: ${response.statusText}. ${text}`)
		}

		const contentType = (response.headers.get('content-type') || '').toLowerCase()
		logger.info(`dots.ocr response content-type: ${contentType}`)

		if (contentType.includes('application/zip')) {
			const arrayBuffer = await response.arrayBuffer()
			const tempZip = path.join(this.storageDir, `${file.id}.zip`)
			await fs.promises.writeFile(tempZip, Buffer.from(arrayBuffer))
			return { type: 'zip', url: tempZip }
		}

		if (contentType.includes('application/json')) {
			const data = await response.json()
			const zipUrl = data.zip_url || data.full_zip_url
			const mdUrl = data.md_url || data.markdown_url
			const md = data.markdown || data.md
			if (zipUrl) return { type: 'zip', url: zipUrl }
			if (mdUrl) return { type: 'md-url', url: mdUrl }
			if (md) return { type: 'markdown', content: md }
			throw new Error('JSON response missing expected fields')
		}

		if (contentType.includes('text/markdown') || contentType.includes('text/plain')) {
			const text = await response.text()
			return { type: 'markdown', content: text }
		}

		// Fallback: assume server wrote outputs into a directory and returned its path
		try {
			const text = await response.text()
			if (fs.existsSync(text) && fs.statSync(text).isDirectory()) {
				return { type: 'directory', dir: text }
			}
		} catch {}

		throw new Error('Unsupported response type from dots.ocr server')
	}

	private async downloadAndExtract(zipUrlOrPath: string, file: FileMetadata): Promise<string> {
		const dirPath = this.storageDir
		const extractPath = path.join(dirPath, file.id)
		const zipPath = path.isAbsolute(zipUrlOrPath) ? zipUrlOrPath : path.join(dirPath, `${file.id}.zip`)

		if (!path.isAbsolute(zipUrlOrPath)) {
			const res = await net.fetch(zipUrlOrPath, { method: 'GET' })
			if (!res.ok) {
				throw new Error(`Failed to download zip: HTTP ${res.status}`)
			}
			const arrayBuffer = await res.arrayBuffer()
			await fs.promises.writeFile(zipPath, Buffer.from(arrayBuffer))
		}

		if (!fs.existsSync(extractPath)) {
			fs.mkdirSync(extractPath, { recursive: true })
		}

		const zip = new AdmZip(zipPath)
		zip.extractAllTo(extractPath, true)
		if (fs.existsSync(zipPath) && path.isAbsolute(zipUrlOrPath)) {
			// If input was an absolute temp zip path we created earlier, clean it
			try { fs.unlinkSync(zipPath) } catch {}
		}
		return extractPath
	}

	private async downloadMarkdown(mdUrl: string, file: FileMetadata): Promise<string> {
		const dir = path.join(this.storageDir, file.id)
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
		const mdPath = path.join(dir, file.origin_name.replace(/\.pdf$/i, '.md'))
		const res = await net.fetch(mdUrl, { method: 'GET' })
		if (!res.ok) throw new Error(`Failed to download markdown: HTTP ${res.status}`)
		const text = await res.text()
		await fs.promises.writeFile(mdPath, text)
		return mdPath
	}

	private async writeMarkdownContent(content: string, file: FileMetadata): Promise<string> {
		const dir = path.join(this.storageDir, file.id)
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
		const mdPath = path.join(dir, file.origin_name.replace(/\.pdf$/i, '.md'))
		await fs.promises.writeFile(mdPath, content)
		return mdPath
	}

	private createFinalFileInfo(file: FileMetadata, mdPath: string): FileMetadata {
		return {
			...file,
			name: file.origin_name.replace(/\.pdf$/i, '.md'),
			path: mdPath,
			ext: '.md',
			size: fs.existsSync(mdPath) ? fs.statSync(mdPath).size : 0
		}
	}

	private createProcessedFileInfo(file: FileMetadata, outputPath: string): FileMetadata {
		let finalPath = ''
		let finalName = file.origin_name.replace(/\.pdf$/i, '.md')
		try {
			const files = fs.readdirSync(outputPath)
			const mdFile = files.find((f) => f.toLowerCase().endsWith('.md'))
			if (mdFile) {
				const originalMdPath = path.join(outputPath, mdFile)
				const newMdPath = path.join(outputPath, finalName)
				try {
					fs.renameSync(originalMdPath, newMdPath)
					finalPath = newMdPath
				} catch {
					finalPath = originalMdPath
					finalName = mdFile
				}
			}
		} catch (error) {
			logger.warn(`Failed to read output directory ${outputPath}: ${error}`)
			finalPath = path.join(outputPath, `${file.id}.md`)
		}
		return {
			...file,
			name: finalName,
			path: finalPath,
			ext: '.md',
			size: fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0
		}
	}
}