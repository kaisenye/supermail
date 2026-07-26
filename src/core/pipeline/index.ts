import type { Processor } from './types.js'
import { parseProcessor } from './parse.js'
import { entitiesProcessor } from './entities.js'

export type { Processor, MsgCtx, RawMessage } from './types.js'
export { runPipeline } from './pipeline.js'
export { extractEntities } from './entities.js'

/**
 * Ordered stage-1 processors. FTS indexing is handled by triggers on the
 * messages table (see schema.sql), so no index processor is needed here.
 *
 * Stage 2 appends embed/summarize/classify to this array — nothing else changes.
 */
export const processors: Processor[] = [parseProcessor, entitiesProcessor]
