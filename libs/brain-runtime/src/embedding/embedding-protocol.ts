/** Main → embedding utility process. Every request carries an id its reply repeats. */
export type ToEmbeddingWorker =
  /** Loads from local files only. Replies `done` once the model is ready. */
  | { type: 'load'; id: number; modelRoot: string; modelName: string; threads: number }
  /** Texts are already prefixed and length-bounded. Replies `vectors`. */
  | { type: 'embed'; id: number; texts: string[] }
  /** Drops a queued request; one already running finishes and its reply is ignored. */
  | { type: 'cancel'; id: number }

/** Embedding utility process → main. */
export type FromEmbeddingWorker =
  | { type: 'done'; id: number }
  | { type: 'vectors'; id: number; vectors: number[][] }
  | { type: 'error'; id: number; message: string }

/** Request bodies, before the client assigns an id. */
export type EmbeddingRequest =
  | Omit<Extract<ToEmbeddingWorker, { type: 'load' }>, 'id'>
  | Omit<Extract<ToEmbeddingWorker, { type: 'embed' }>, 'id'>
