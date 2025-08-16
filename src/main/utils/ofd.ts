import { spawn } from 'node:child_process'
import fs from 'node:fs'

/**
 * Try to run a command and resolve if exit code is 0.
 */
function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'ignore' })
		child.on('error', (err) => reject(err))
		child.on('exit', (code) => {
			if (code === 0) resolve()
			else reject(new Error(`${command} exited with code ${code}`))
		})
	})
}

/**
 * Convert OFD to PDF using external tools.
 * Preference order:
 * - Env var OFD2PDF_BIN or MAIN_VITE_OFD2PDF_BIN (CLI: ofd2pdf <input> <output>)
 * - Env var OFDRW_JAR or MAIN_VITE_OFDRW_JAR (CLI: java -jar <jar> <input> <output>)
 * - Fallback: try `ofd2pdf` on PATH
 */
export async function convertOfdToPdf(inputPath: string, outputPath: string): Promise<void> {
	if (!fs.existsSync(inputPath)) {
		throw new Error(`OFD file not found: ${inputPath}`)
	}
	const ofd2pdfBin = process.env.OFD2PDF_BIN || (import.meta as any)?.env?.MAIN_VITE_OFD2PDF_BIN
	const ofdrwJar = process.env.OFDRW_JAR || (import.meta as any)?.env?.MAIN_VITE_OFDRW_JAR

	// Ensure output dir exists
	fs.mkdirSync(require('node:path').dirname(outputPath), { recursive: true })

	if (ofd2pdfBin) {
		await run(ofd2pdfBin, [inputPath, outputPath])
		if (!fs.existsSync(outputPath)) {
			throw new Error('Conversion reported success but output PDF not found')
		}
		return
	}

	if (ofdrwJar) {
		await run('java', ['-jar', ofdrwJar, inputPath, outputPath])
		if (!fs.existsSync(outputPath)) {
			throw new Error('Conversion reported success but output PDF not found (jar)')
		}
		return
	}

	// Fallback: try `ofd2pdf` on PATH
	try {
		await run('ofd2pdf', [inputPath, outputPath])
	} catch (e) {
		throw new Error(
			'No OFD->PDF converter found. Please set OFD2PDF_BIN or OFDRW_JAR (or MAIN_VITE_* variants) to enable conversion.'
		)
	}
	if (!fs.existsSync(outputPath)) {
		throw new Error('Conversion failed: output PDF not generated')
	}
}