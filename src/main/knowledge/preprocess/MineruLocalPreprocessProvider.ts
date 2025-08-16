import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { fileStorage } from '@main/services/FileStorage'
import { getBinaryPath, isBinaryExists } from '@main/utils/process'
import { FileMetadata, PreprocessProvider } from '@types'
import { spawn } from 'child_process'

import BasePreprocessProvider from './BasePreprocessProvider'

const logger = loggerService.withContext('MineruLocalPreprocessProvider')

export default class MineruLocalPreprocessProvider extends BasePreprocessProvider {
	constructor(provider: PreprocessProvider, userId?: string) {
		super(provider, userId)
	}

	public async parseFile(
		sourceId: string,
		file: FileMetadata
	): Promise<{ processedFile: FileMetadata; quota?: number }> {
		try {
			const filePath = fileStorage.getFilePathById(file)
			logger.info(`MinerU local preprocess started: ${filePath}`)

			await this.validateFile(filePath)

			// Run local magic-pdf to parse
			const { outputDir } = await this.runMagicPdf(file, sourceId)

			// Build processed file info (prefer .md)
			const processedFile = this.createProcessedFileInfo(file, outputDir)

			return { processedFile }
		} catch (error: any) {
			logger.error(`MinerU local preprocess failed:`, error as Error)
			throw new Error(error.message || String(error))
		}
	}

	public async checkQuota(): Promise<number> {
		// Local deployment has no quota
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

	private async runMagicPdf(file: FileMetadata, sourceId: string): Promise<{ outputDir: string }> {
		const cmd = await getBinaryPath('magic-pdf')
		const exists = await isBinaryExists('magic-pdf')
		if (!exists) {
			// Fallback to PATH lookup; spawn will error if not installed
			logger.warn('magic-pdf binary not found in managed bin dir; will try to use system PATH')
		}

		const inputPath = fileStorage.getFilePathById(file)
		const outputDir = path.join(this.storageDir, file.id)
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true })
		}

		return new Promise<{ outputDir: string }>((resolve, reject) => {
			const args = ['-p', inputPath, '-o', outputDir, '-m', 'auto']
			logger.info(`Executing magic-pdf ${cmd} ${args.join(' ')}`)
			const child = spawn(cmd, args)

			let lastProgressSent = 0
			child.stdout.on('data', async (data) => {
				const text = data.toString()
				// Try to extract percentage like "xx%"
				const match = text.match(/(\d{1,3})%/)
				if (match) {
					const percent = Math.max(0, Math.min(100, parseInt(match[1], 10)))
					if (percent - lastProgressSent >= 3) {
						lastProgressSent = percent
						await this.sendPreprocessProgress(sourceId, percent)
					}
				}
				logger.debug(`[magic-pdf] ${text.trim()}`)
			})

			child.stderr.on('data', (data) => {
				logger.warn(`[magic-pdf][stderr] ${data.toString().trim()}`)
			})

			child.on('error', (err) => {
				reject(new Error(`Failed to start magic-pdf: ${err.message}`))
			})

			child.on('close', async (code) => {
				if (code === 0) {
					await this.sendPreprocessProgress(sourceId, 100)
					resolve({ outputDir })
				} else {
					reject(new Error(`magic-pdf exited with code ${code}`))
				}
			})
		})
	}

	private createProcessedFileInfo(file: FileMetadata, dir: string): FileMetadata {
		// Prefer a .md file in output; common naming: <basename>.md
		const baseName = path.basename(file.origin_name, path.extname(file.origin_name))
		const preferred = path.join(dir, `${baseName}.md`)
		let finalPath = preferred

		if (!fs.existsSync(preferred)) {
			// fallback: first .md in dir
			const files = fs.readdirSync(dir)
			const md = files.find((f) => f.toLowerCase().endsWith('.md'))
			if (md) {
				finalPath = path.join(dir, md)
			} else {
				// fallback: create empty md
				finalPath = preferred
				fs.writeFileSync(finalPath, '')
			}
		}

		return {
			...file,
			name: `${baseName}.md`,
			path: finalPath,
			ext: '.md',
			size: fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0
		}
	}
}