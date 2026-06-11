// Streaming intake for a cids.txt file picked (or dropped) in the console
// (#50). An inventory file can run to tens of thousands of lines, so the file
// is decoded chunk-by-chunk off `File.stream()` and complete lines are fed to
// the shared collector — the list never materializes as one string the way
// textarea input does. Reads via getReader(): ReadableStream async iteration
// is not available in every supported browser.
import { type CidIntake, createCidCollector } from 'ipfs2foc-core/cid-list'

export type { CidIntake }

export async function parseCidFile(file: File): Promise<CidIntake> {
  const collector = createCidCollector()
  const decoder = new TextDecoder()
  const reader = file.stream().getReader()
  let carry = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      carry += decoder.decode(value, { stream: true })
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) collector.line(line)
    }
  } finally {
    reader.releaseLock()
  }
  carry += decoder.decode()
  if (carry !== '') collector.line(carry)
  return collector.result()
}
