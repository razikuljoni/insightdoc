# InsightDoc — Worklog

Project: InsightDoc — Autonomous PDF Analytics & Vector Search Pipeline (Enterprise RAG)
Spec: /home/z/my-project/upload/InsightDoc_Full_Project_Spec.md

## Sandbox Architecture Adaptations (spec → sandbox mapping)
- PostgreSQL 16 + pgvector → SQLite (Prisma) + app-layer vector store (cosine similarity, embeddings stored as JSON TEXT, 1536-dim)
- Redis + BullMQ → in-process singleton job queue (globalThis-cached, survives HMR) with retry/backoff + DB-persisted progress
- AWS S3/R2 → local disk storage under `storage/uploads/` served via API route
- OpenAI text-embedding-3-small → `EmbeddingService` abstraction w/ deterministic local hashed embedder (1536-dim, swappable)
- OpenAI gpt-4o → z-ai-web-dev-sdk `chat.completions.create` (stream: true, backend-only)
- Cohere reranker → hybrid RRF (Reciprocal Rank Fusion) + score-weighted reranking
- Multi-route pages → single `/` route SPA (sandbox constraint) with client-side view switching
- @react-pdf-viewer/core → react-pdf (pdfjs-dist) with customTextRenderer for citation highlighting

---
Task ID: 0
Agent: orchestrator (Z.ai Code)
Task: Spec analysis, SDK surface verification, architecture adaptation, plan

Work Log:
- Read full spec (InsightDoc_Full_Project_Spec.md)
- Verified z-ai-web-dev-sdk: chat completions w/ stream:true returns ReadableStream (OpenAI-compatible SSE chunks); NO embeddings endpoint → local embedder needed
- Verified env: Next 16 + React 19 + Tailwind 4 + shadcn/ui, Prisma SQLite at db/custom.db, DATABASE_URL set
- Planned 5-phase build per spec §7

Stage Summary:
- Phase plan established; beginning Phase 1 (schema + core libs)

---
Task ID: 1-3
Agent: orchestrator (Z.ai Code)
Task: Phase 1 (Foundation) + Phase 2 (Ingestion) + Phase 3 (RAG/SSE) backend

Work Log:
- Prisma schema (SQLite): User, Workspace, WorkspaceMember, Document, DocumentChunk (embeddingJson TEXT), ChatSession, ChatMessage, ApiKey, UsageEvent, AuditLog; db:push OK
- src/lib/types.ts — full Zod contract layer (DTOs, SSE frames, validation)
- src/lib/tokenizer.ts, embeddings.ts (1536-dim hashed embedder + cosine math), chunker.ts (page-scoped 1000/200 sliding window)
- src/server/rag/retriever.ts — BM25 + cosine hybrid, RRF fusion, coverage reranker, top-5 citations
- src/server/storage.ts (local S3 substitute), audit.ts (usage ledger + audit trail), queue.ts (singleton job queue, retry/backoff/concurrency 2)
- src/server/worker/document-processor.ts — unpdf extraction → chunk → batch embed → persist, staged progress 2→100
- API v1 routes: workspaces (list/create), upload (multipart+RBAC+magic-byte check), documents (list/detail/delete/status/process/file w/ Range), chats (list/create/get/delete), stream (SSE: citations→retrieval→token→done frames), analytics, export (md/json)

Stage Summary:
- All backend routes implemented and type-safe; SSE contract matches spec §5.2
- Next: Phase 4 frontend SPA (split-screen chat + react-pdf viewer)

---
Task ID: 4-6
Agent: orchestrator (Z.ai Code)
Task: Phase 4 (Frontend SPA) + Phase 5 (Analytics/Export) + E2E verification

Work Log:
- globals.css: spec §6.1 design system (slate dark default #0F172A, indigo #6366F1 primary, cyan #06B6D4 citation highlights), custom scrollbars, streaming caret, grid texture
- components/insightdoc/: api-client.ts (Zod-parsed fetchers + SSE reader), store.ts (Zustand), insightdoc-app.tsx (shell+polling), chat-view.tsx (17/38/45 resizable split), chat-panel.tsx (streaming, scope selector, citation cards), pdf-viewer-panel.tsx (react-pdf, windowed pages, thumbnails, zoom, customTextRenderer highlight), message-renderer.tsx ([n]→citation pills), documents-view.tsx, dashboard-view.tsx, analytics-view.tsx (recharts), upload-zone.tsx (XHR progress), scripts/make-test-pdf.ts
- Fixed during verification: embedder async/Promise bug; HMR-defeated globalThis singleton (restart); message loading on chat switch (fetchChatMessages effect); pdf.worker copied to public; controller-already-closed on client disconnect (send/finish guards)
- E2E verified via agent-browser: dashboard live data, upload→ingest→Indexed badge, chat history, live SSE answer (grounded, correct figures), citation pill → page-4 jump with cyan in-PDF highlights + source card, analytics charts ($0.0082, 3703 tokens), mobile 390px responsive. Lint clean, no runtime errors.

Stage Summary:
- All 5 spec phases implemented and browser-verified. Platform is fully functional: upload → pipeline → hybrid RAG → streamed cited answers → PDF deep-linking → analytics/export.

---
Task ID: cron-review-1 (round 2)
Agent: orchestrator (Z.ai Code)
Task: Status assessment, QA pass, Semantic Search feature + document inspector + command palette + styling polish

Work Log:
- QA (all passed): dashboard/chat/analytics views, browser UI upload path (test-contracts.pdf ingested via file input), no console errors, live chat RAG verified with real user data (user uploaded their own resume — indexed 2 pages/2 chunks)
- NEW API: POST /api/v1/search (hybrid retrieval top-12, audit 'search.query'), GET /api/v1/documents/:id/chunks (paged chunk inspector, heading/tokenCount/preview)
- NEW VIEW: SearchView — cross-document semantic search with animated score bars, query-term <mark> highlighting, stats line (vector/keyword/fuse/rerank timings), suggestions chips, staggered framer-motion results, 'Open page N in viewer' deep-link (reuses pdfTarget; ChatView condition relaxed to show viewer without active chat)
- NEW: DocumentDetailDialog — metadata grid + paginated 'Vector index contents' inspector with per-chunk page badge, heading, token count, preview, View-page jump; wired to document rows in library
- NEW: CommandPalette (cmdk, ⌘K/Ctrl+K + sidebar trigger) — navigate views, open docs in viewer, search actions, new chat, theme toggle, workspace switch
- STYLE: AnimatePresence view transitions (fade/slide 160ms), citation-card hover lift + cyan glow shadow, suggested-question chips on chat empty state (from indexed doc titles), Command-menu footer button with ⌘K kbd chip, Search nav item
- Fixed: JSX div imbalance in app-shell footer; setState-in-effect lint errors (dialog reset + search palette effect)
- Verified via agent-browser: search 'revenue growth outlook' (12 passages, term highlights, 3ms rerank), chunk inspector on real resume, ⌘K palette open/navigate, search→'Open page'→resume rendered in viewer page 1 without active chat, live RAG on resume ('Summarize this candidate...' → grounded answer). Lint clean, zero runtime errors.

Stage Summary:
- Platform now has 5 views (Dashboard, Documents, RAG Chat, Search, Analytics) + global overlays (palette, doc inspector)
- Suggested next round: PDF text-layer snippet sync improvements, chat message actions (copy/export turn), document re-name/re-title, multi-workspace bulk ops, OCR fallback messaging for scanned PDFs

---
Task ID: cron-review-2 (round 3)
Agent: orchestrator (Z.ai Code)
Task: Status assessment, browser QA, bug fixes, message/document/chat management features, mobile-responsive chat layout

Work Log:
- QA (agent-browser): all 5 views, live SSE RAG (grounded answers verified), citation→PDF jump w/ highlights, search w/ term highlighting, chunk inspector, analytics — all functional; zero console/page errors
- BUG FIX 1 (click-blocking): Radix ScrollArea viewport renders child as `display: table` → truncate() defeated → chat-session buttons overflowed beneath the center panel and swallowed clicks. Fixed globally in globals.css (`[data-radix-scroll-area-viewport] > div { display:block !important; min-width:100% !important }`); verified hit-target now the button itself
- BUG FIX 2 (a11y): shadcn CommandDialog rendered sr-only DialogHeader OUTSIDE DialogContent → leaked "Command Palette" title into page a11y tree when closed. Moved header inside DialogContent (unmounts with dialog)
- BUG FIX 3: documents table column rebalance (titles were crushed to ~50px); right-aligned numeric columns, flexible title column
- NOTE: globalThis queue singleton caches the OLD processor handler across HMR — dev-server restart required after worker changes (recurring gotcha, 2nd occurrence)
- FEATURE chat.turn-actions: hover action bar per message — Copy (answers copy as Markdown incl. sources), Export turn (.md w/ citations + retrieval stats), Regenerate (new DELETE /api/v1/chats/:id/messages?fromMessageId=&keepAnchor= truncates tail server-side, then re-streams); clipboard falls back to execCommand
- FEATURE stop-generation: Stop button replaces Send during streaming (AbortController; partial turn discarded cleanly, user prompt persists like ChatGPT semantics)
- FEATURE document.rename: PATCH /api/v1/documents/:id (Zod RenameDocumentSchema, RBAC VIEWER-forbidden, audit 'document.rename'); inline editor in library table (pencil btn + double-click, Enter/Escape/blur) and in chunk-inspector dialog header
- FEATURE chat.rename: PATCH /api/v1/chats/:id (audit 'chat.rename'); inline rename in session rail (pencil/double-click)
- FEATURE scanned-PDF detection: worker Stage 2.5 computes non-whitespace chars/page; below 24 chars/page → NonRetryableError '[SCANNED_PDF] ...' → queue skips retries (verified: 'not retryable' in log, 0 retry burn vs 3 before); extraction failures now '[EXTRACTION_FAILED]'; UI renders amber ScanLine + friendly copy via friendlyDocumentError(); retry button still available
- FEATURE mobile chat layout: <768px replaces 3-panel split with segmented Chats/Conversation/Document panes (shared session rail component); tapping a citation auto-flips to Document pane; New chat / session click land on Conversation pane
- UX: delete-document now asks AlertDialog confirmation; sonner toasts wired globally (layout.tsx Toaster swap) for copy/rename/delete/stop/errors
- VERIFIED via agent-browser: rename flows (document + chat) w/ toasts, regenerate (tail truncated, new streamed answer cites renamed doc), stop mid-stream (no error, composer restored), mobile 390px panes (Chats list full-width readable, Conversation, Document), light+dark themes, desktop 3-panel intact, search regression pass (12 passages, 5ms rerank)

Stage Summary:
- Platform now: 5 views + palette + inspector + turn actions + rename mgmt + scanned-PDF taxonomy + true mobile layout; all routes Zod-typed end-to-end
- Known risks: (1) restart dev server after editing src/server/worker/* (queue singleton); (2) aborted streams persist the user prompt without an answer (by design); (3) [SCANNED_PDF] detection threshold 24 chars/page may false-positive on tiny text PDFs (raise if needed)
- Suggested next round: OCR adapter slot (tesseract.js) behind a feature flag; share/export whole chat as MD from header; workspace-scoped search filters; drag-and-drop upload anywhere; E2E smoke script

---
Task ID: cron-review-3 (round 4)
Agent: orchestrator (Z.ai Code)
Task: Status assessment, browser QA, global drop-upload, search scoping, bulk ops, export menu, shortcuts, activity feed, styling detail pass

Work Log:
- QA first (agent-browser): all 5 views healthy, live SSE RAG answer grounded (segments $454M/32%, $356M/25%, 5 citations, 2.1s), search + analytics render, citation cards OK, zero console errors → platform stable → proceeded to features (no blocking bugs found)
- FEATURE global drop-upload: window-level dragenter/over/leave/drop listeners (dragDepth counter) → full-screen animated "Release to upload" overlay (workspace name, spring pop, floating icon) → XHR batch upload with floating bottom-right progress card (file count, bytes, %, per-file rejection rows, completion flash). Shared validation extracted to src/lib/file-validation.ts (PDF-only, 50MB, non-empty) — UploadZone now consumes it (single source of truth). Uploads upsert into store; ingestion polling picks status up automatically
- FEATURE search scope chips: SearchView local multi-select document filter (independent of chat scope selector) → passes documentIds to POST /api/v1/search (already supported); active chip w/ X, "All documents (N)" reset; verified single-doc search returns only that doc's passages (8/8 test-contracts)
- FEATURE documents bulk ops: checkbox column + header select-all (indeterminate state), bulk action bar (n selected · total size · Clear · Delete selected), sequential delete loop with success/failure tally toast, AlertDialog confirm, row highlight when selected. Verified end-to-end by uploading then bulk-deleting a QA doc
- FEATURE chat export menu: header kebab (visible when messages exist) → Export as Markdown / Export as JSON (same-origin anchor download of existing /export route) + Copy conversation (client-side conversationToMarkdown w/ sources; clipboard + execCommand fallback). Server export verified via curl (11-turn MD report)
- FEATURE shortcuts: '?' toggles help dialog (typing-guard), Alt+1..5 switches views, ShortcutsDialog lists Views (click-to-jump rows) + General; sidebar footer now Commands ⌘K / Shortcuts ? twin buttons; palette gains "Keyboard shortcuts" action
- FEATURE activity feed: NEW GET /api/v1/activity (Zod query validation, workspace RBAC membership check, audit tail N) + fetchActivity (Zod-parsed) + Dashboard timeline: per-action icon/color map (upload/rename/delete/reprocess/chat create/query/rename/truncate/search/export), "actor did X" copy, relative timestamps, connector lines, skeletons, 30s refresh. Verified live: QA upload/delete appeared as "just now"
- STYLE: StatCards tone system (primary/cyan/emerald/amber gradient icon chips + top accent bar + hover lift + sheen ::before), sidebar nav animated layoutId pill (spring), branded boot screen (glowing iD logo, shimmer progress bar), ::selection brand tint, :focus-visible ring refinement, global kbd chip style, score-shimmer on search relevance bars, table row hover tint, UploadZone "or drop PDFs anywhere" hint
- Fixed during round: transient HMR 'ReferenceError: z is not defined' (api-client import landed after first save — resolved by full reload, no recurrence)

Stage Summary:
- Verified E2E: drop overlay → upload card → ingestion → Indexed; bulk select/delete; search scoping; export menu + server MD; '?' dialog; Alt+2/3/4 navigation; activity feed live updates; light+dark themes; mobile 390px dashboard
- All routes Zod-typed; lint clean; no console errors
- Known risks: (1) restart dev server after editing src/server/worker/* (queue singleton, recurring); (2) global drop overlay ignores drops while an upload batch is in flight (busyRef guard — intentional); (3) '?' help can't open while focused in inputs (by design)
- Suggested next round: PDF outline/bookmark side panel in viewer; per-message feedback (👍/👎 persisted); workspace settings dialog (rename/description/members); OCR adapter (tesseract.js) behind flag; E2E smoke script (scripts/smoke.ts) hitting upload→chat→search in CI-style run

---
Task ID: cron-review-4 (round 5)
Agent: orchestrator (Z.ai Code)
Task: Status assessment, browser QA, answer feedback loop (persisted 👍/👎), workspace settings, in-PDF full-text search, styling details

Work Log:
- QA first (agent-browser): all 5 views healthy; live SSE RAG verified end-to-end — asked "payment terms in the contracts?" → honest "not in context" answer citing only relevant passages (no hallucination); search "revenue growth outlook" (12 passages, 6ms rerank); analytics live ($0.0775 / 26,854 tokens); zero console errors → platform stable → proceeded to features
- FEATURE message.feedback: Prisma ChatMessage.feedback ('UP'|'DOWN'|null) + db:push; Zod SetMessageFeedbackSchema + MessageFeedbackSchema in types.ts; PATCH /api/v1/chats/:sessionId/messages (moved truncate DELETE into same module + shared requireSessionMember helper; annotation allowed for ALL roles incl. VIEWER, audit 'message.feedback' only on meaningful set); FeedbackButtons in chat-panel hover action bar (toggle same value clears, optimistic store update with rollback on failure, emerald/rose states, fill-current, insightdoc-pop micro-animation, aria-pressed); store.setMessageFeedback; export routes include feedback (JSON field + MD '🤖 InsightDoc 👍' heading marker); analytics adds feedback {up,down} counts
- FEATURE analytics answer-quality: new "Answer quality" card — % rated helpful (emerald), gradient progress bar over rose track, up/down counters, progressbar ARIA, dashed empty state guiding to 👍/👎; verified 100% bar with 1 up
- FEATURE workspace settings: PATCH /api/v1/workspaces/:workspaceId (UpdateWorkspaceSchema, ADMIN-only RBAC → 403 otherwise, audit 'workspace.update', returns fresh rollup WorkspaceDTO); WorkspaceSettingsDialog in sidebar (gear trigger with hover-rotate micro-interaction next to +, name/description editing, 300-char counter, read-only facts grid: docs/chats/members/KB/slug/created, amber VIEWER/MEMBER notice, dirty-gated Save); save updates store in place — dashboard hero description updated live
- FEATURE pdf-viewer search: TextSearch toolbar toggle → amber search bar; lazy per-page getTextContent extraction (pdfDocRef from onLoadSuccess, cached per document, 'extracting text…' progress); normalized phrase matching → per-page match groups with previews; "i/N" counter (aria-live), Enter=next / Shift+Enter=prev across pages w/ smooth scroll + stepper sync; clickable per-page chips (p.3 × 4) with current-page amber state; amber in-text marks via extended customTextRenderer (search terms on every page + cyan citation grams on the citation page, overlap-resolved range merger), 'N matches' page badge + amber ring on current page; no-match hint; Esc closes/clears
- BUG FIX (found during QA): pressing Enter after typing a NEW query stepped the old match instead of re-running the search — added lastQueryRef; Enter re-runs when query differs, steps when identical (verified: revenue → 1/6, then zzz… → re-ran → 'no matches')
- STYLE: .search-highlight (amber, light+dark vars) + .search-highlight-current, insightdoc-pop spring keyframe (:active scale/rotate), workspace gear hover:rotate-45, quality-bar gradient animation
- Gotcha hit again: Prisma client regenerated by db:push not picked up by running Next server → PATCH 500 'Unknown argument feedback' → dev-server restart fixed (3rd occurrence of stale-client/HMR restart pattern; message GET parse also requires server restart after schema+DTO changes)
- Verified via agent-browser: feedback set→toast→persist across reload (aria-pressed=true, analytics up=1, audit rows, MD/JSON export markers); workspace rename save→live sidebar/dashboard update + validation (empty name 400) + restore; PDF search full loop (open, run, chips, next×4 → page 4 @ 5/6, no-match state, Esc); light+dark themes; mobile 390px (quality card + charts responsive); lint clean; zero console errors; dev log clean

Stage Summary:
- Platform now: 5 views + palette + inspector + turn actions + rename mgmt + scanned-PDF taxonomy + mobile layout + GLOBAL feedback loop (UI→API→audit→analytics→exports) + workspace metadata management + in-PDF full-text search
- Known risks: (1) restart dev server after schema/Prisma-client or src/server/worker/* changes (recurring); (2) PDF search extracts text lazily on first query per document — very large PDFs will show a one-time extraction delay; (3) feedback allowed for VIEWERs by design (annotation, not content edit)
- Suggested next round: OCR adapter (tesseract.js) behind feature flag for [SCANNED_PDF] docs; E2E smoke script (scripts/smoke.ts) upload→chat→search→feedback; feedback-driven "low-rated answers" review queue in analytics; PDF outline/bookmarks panel; per-document search scope inside viewer search (current: whole doc)

---
Task ID: cron-review-5 (round 6)
Agent: orchestrator (Z.ai Code)
Task: Status assessment, browser QA, voice I/O (ASR+TTS), follow-up suggestions, duplicate upload detection, feedback review queue

Work Log:
- QA first (agent-browser): all 5 views healthy, search 12 passages @ 4ms rerank, analytics charts + quality card render, documents library + bulk select OK, zero console errors → platform stable → proceeded to features (no blocking bugs)
- FEATURE voice input (ASR): POST /api/v1/audio/transcribe (multipart audio → base64 → zai.audio.asr.create, 15MB cap, 422 on empty transcript); VoiceRecorder component in composer — MediaRecorder (webm→mp4 fallback), pulsing red recording pill w/ mm:ss timer + discard(X)/confirm(✓) buttons, "Transcribing…" state, graceful toasts for NotAllowedError/NotFoundError/unsupported browsers, unmount teardown; transcription appends to composer input
- FEATURE read-aloud (TTS): POST /api/v1/audio/speech (Zod ≤6000 chars, speed 0.5-2.0) — splits text on sentence boundaries ≤950 chars (TTS API caps 1024), synthesizes per chunk with 3-attempt retry + backoff (upstream 500s observed), strips markdown/citation markers, extracts PCM from each WAV and re-builds ONE seamless 24kHz/16-bit WAV header; client narrate() with single-flight module player, per-message Volume2 button in hover action bar → Loader2 while synthesizing + "Synthesizing narration…" toast (id-chained success/error update) → animated .eq equalizer bars while playing → Stop narration; synthesis cancellable via AbortController (button becomes Cancel narration); narration auto-stops on chat switch/new stream
- Voice loop VERIFIED: TTS text→WAV→ASR→exact transcription round-trip via curl (11.4% revenue sentence transcribed word-perfect); UI playback verified incl. 19s long-answer synthesis then equalizer + stop
- FEATURE follow-up suggestions: POST /api/v1/chats/:id/followups (RBAC session member, last-4-message transcript, JSON-array extraction with line-based fallback, 409 if no answer yet) → 3 chips above composer with Sparkles label, skeleton loaders, staggered rise-in animation, click = send question (verified grounded answer streamed), RefreshCw re-roll; fetch-once per messageId (Set ref) to bound LLM cost
- FEATURE duplicate upload detection: upload route computes SHA-256 checksum (schema field existed unused), findFirst same-checksum-in-workspace with status != FAILED → friendly error 'Duplicate: this file's content already exists as "X" (status) — nothing re-indexed'; FAILED docs allowed through for retry; checksum persisted + audit detail; verified via curl (2nd upload rejected while 1st processing)
- FEATURE feedback review queue: GET /api/v1/feedback-review?rating=DOWN|UP&limit (Zod query, user-owned sessions, preceding question attached, citations count) + Analytics "Feedback review — low-rated answers" card — flagged items with session title, italic Q preview, 2-line answer preview, relative time, citation count; click → setActiveChat(sessionId) + view switch; verified E2E (rated answer 👎 → 1 flagged → jump back to conversation)
- STYLE: .followup-chip staggered followup-in animation + primary hover glow; .eq/.eq-bar 3-bar bounce equalizer; recording pill (rose border, ping dot); review-queue rose hover tint
- Fixed during round: upstream TTS 500 (网络错误) → added ttsWithRetry 3-attempt backoff (subsequent runs 200); duplicate `send` definition from staged edit (caught + removed pre-commit); unused imports pruned
- Verified: light+dark themes, mobile 390px (chips wrap, mic fits, no h-overflow), Alt+1..5 nav, lint clean, dev log clean, fresh browser session zero console/page errors

Stage Summary:
- Platform now: 5 views + palette + inspector + turn actions + rename mgmt + scanned-PDF taxonomy + mobile layout + feedback loop + voice I/O (ask by voice, listen to answers) + LLM follow-ups + content-hash de-dup + low-rated answer review queue
- Known risks: (1) restart dev server after schema/Prisma-client or src/server/worker/* changes (recurring); (2) long answers take ~10-20s to narrate (chunked TTS, mitigated by cancel + toast); (3) upstream TTS/ASR occasional 500s — retries added, remaining failures surface as toasts; (4) mic needs a real device — headless sandbox has none (graceful toast verified); (5) followups add one LLM call per new answer (bounded by per-message memo)
- Suggested next round: playback speed toggle (0.75/1/1.25) on narration; "ask about this page" button in PDF viewer toolbar (pre-fills composer with page context); document star/favorites; E2E smoke script (scripts/smoke.ts) upload→chat→search→feedback; OCR adapter behind flag for [SCANNED_PDF]
---
Task ID: cron-review-6 (round 7)
Agent: orchestrator (Z.ai Code)
Task: Status assessment, browser QA, retrieval-quality bug fix (stemmer + dedup + heading boost), star/favorites, ask-about-this-page, narration speed, workspace delete, E2E smoke script, styling pass

Work Log:
- QA first (agent-browser): all 5 views healthy, live SSE RAG streamed w/ citations, search/analytics render, zero console errors → proceeded to features after finding a REAL retrieval-quality bug during QA
- BUG FIX 1 (retrieval, HIGH): stemmer plural bug — stem('revenues')→'revenu' vs stem('revenue')→'revenue' never matched, so queries containing "revenues/margins/segments" missed the exact passages ("Total Q3 FY2026 revenue was $1.42 billion" ranked OUT of top-5; QA answer honestly said "not in context"). Fixed tokenizer.ts with generic final-s strip (guarded ss/us/is) + ch/sh/x/z+s 'es' rule; verified stems: revenues→revenue, matches→match, losses→loss, companies→company, assets→asset
- BUG FIX 2 (retrieval): near-duplicate flooding — duplicate-content docs (test-contracts = byte-different copy of the 10-Q) put the SAME passage 2-4× in top-5. Added MMR-style greedy diversity selection (token-Jaccard ≥0.82 = duplicate, skipped w/ backfill) in rerankCandidates → all 5 citations now unique
- BUG FIX 3 (retrieval): heading signal unused — heading terms now count at double weight toward coverage + explicit +0.06 heading-hit bonus ("SECTION 3. REVENUE RECOGNITION" matches revenue queries)
- Infra: EMBEDDING_MODEL_ID bumped v1→v2 (embedder shares the tokenizer → feature-space change). Added Document.embeddingModel column + bootstrap self-heal: COMPLETED docs with stale embeddingModel are silently re-enqueued for reindex on boot (transparent migration pattern). Verified: "[bootstrap] re-enqueued 2 document(s)"; all 3 docs now v2. Gotcha hit: getQueue() is async (await it); failed first run left one doc PENDING → cleaned via direct processDocumentJob
- VERIFIED retrieval E2E: same question now returns "$1.42 billion, up 11.4% + Industrial Automation $610M (43%) / Robotics $454M (32%) / Energy Systems $356M (25%)" with citation → test-contracts p.3; search top-1 = revenue passage (0.64)
- FEATURE document star/favorites: Document.starred column; PATCH /documents/:id generalized (UpdateDocumentSchema {title?|starred?}, audit 'document.star'/'document.unstar', VIEWER-forbidden); store.toggleDocumentStar (optimistic + rollback); Documents view: inline star button next to title (always visible when starred, hover-reveal otherwise), amber left-border + warm row wash, starred-first sort, "Starred N" filter chip w/ count + empty-state copy; detail-dialog header star; dashboard Recently-updated rows show amber star badge
- FEATURE ask-about-this-page: viewer toolbar button → store.prefillComposer + view switch; ChatPanel consumes composerPrefill {text,nonce}, AUTO-CREATES a chat when none is active (verified empty-state flow), appends draft, focuses + caret-to-end; verified E2E: 'About page 3 of "test-contracts": ' prefilled → question answered with segment figures, citations [1] test-contracts p.3
- FEATURE narration speed: NARRATION_SPEEDS [0.75,1,1.25,1.5] cycle chip appears next to the equalizer while narrating; applies audio.playbackRate live + persists (localStorage insightdoc-tts-speed); verified 1×→1.25× click + persistence
- FEATURE workspace delete: DELETE /api/v1/workspaces/:id (ADMIN-only, 409 on last workspace, disk files removed first, DB cascade w/ audit SetNull); settings dialog gains Danger zone (counts embedded in copy) + AlertDialog confirm; store.removeWorkspace falls back to first survivor and clears doc/chat state; verified 200 + sidebar cleanup of 8 leftover smoke/dbg workspaces
- FEATURE smoke script: scripts/smoke.ts — 13 checks: workspace create → upload → duplicate-upload rejection → ingestion poll → hybrid search (revenue passage) → SSE chat (citations frame + grounded $1.42B/Industrial Automation answer, event:/data: SSE parser) → feedback → star → doc+workspace cleanup; 13/13 passing in ~10s; exit code correct
- STYLE: star-pop keyframe (scale+rotate bounce on star), row-starred warm hover wash, star-filter-focus amber focus-visible ring, dashboard star badges, viewer 'Ask about this page' primary-tinted toolbar button, danger-zone destructive panel
- Cleanup: removed 8 orphaned smoke/debug workspaces + files; smoke script now self-cleans its workspace

Stage Summary:
- Retrieval quality materially improved (plural stemming + diversity + heading boosts + embedding-model versioning/self-heal); star/favorites, viewer→composer context hand-off, narration speed control, workspace lifecycle (delete), and a reusable CI-style smoke harness added
- Known risks: (1) restart dev server after schema/Prisma-client or src/server/worker/* changes (recurring); (2) DUPLICATE_JACCARD=0.82 may treat genuinely-identical boilerplate pages (e.g. same TOS text in 2 docs) as duplicates — intentional, backfill keeps top-K full; (3) 'Ask about this page' while a stream is active: prefill fills the disabled textarea (sent after stream ends); (4) smoke script needs scripts/make-test-pdf.ts run first (checked, exits with instructions)
- Suggested next round: OCR adapter (tesseract.js) behind flag for [SCANNED_PDF]; chat message virtualization for 100+ message sessions; per-document search scope inside viewer search; multi-select document compare view; upload folder drag-drop (directory picker)

---
Task ID: cron-review-7 (round 8)
Agent: orchestrator (Z.ai Code)
Task: Status assessment, browser QA, type-hygiene fixes, stale-workspace self-heal, chat pinning, document AI digest, prompt library, styling pass

Work Log:
- QA first (agent-browser): all 5 views healthy; live SSE RAG re-verified ("total revenue + leading segment?" → $1.42B, 11.4%, Industrial Automation $610M 43% w/ citation p.3); citation→PDF jump w/ cyan highlights + source card; search 12 passages @ 4ms; analytics $0.1366/56,110 tokens; zero console errors → platform stable
- BUG (robustness, from dev.log): stale active-workspace polling loop — a client whose active workspace is deleted server-side (other tab/admin/cleanup script) kept polling /activity forever with 403s. Fixed with self-heal: ApiError class (status on fetch failures) + store-level workspace-invalid event bus (onWorkspaceInvalid/notifyWorkspaceInvalid); shell listener re-fetches workspaces (ref-guarded), falls back to first survivor w/ toast (or empty state + warning when none left); signals wired from loadWorkspaceData catch, ingestion-poll catch, and dashboard ActivityFeed catch. VERIFIED E2E: created scratch ws → activated in browser → DELETE via curl → within one 30s poll cycle app fell back to "Q4 Financial Review" with full data reload, zero console errors
- TYPE HYGIENE: bunx tsc revealed 6 pre-existing errors in src/ (lint can't catch) — activity route targetType/targetId nullability (server coerce + honest client schema), upload route toDto({...doc, fileUrl}) excess property, SSE regex `s` flag vs ES2017 target → [\s\S], narration speed useState type (typeof NARRATION_SPEEDS)[number], message-renderer onCitation arity. src/ now fully tsc-clean (examples/skills/scripts excluded from scope)
- FEATURE chat.pin: ChatSession.pinnedAt column; PATCH /chats/:id generalized (UpdateChatSchema {title?|pinned?}, RBAC VIEWER-forbidden, audit chat.pin/chat.unpin); store.toggleChatPin optimistic w/ rollback; session rail: pinned-first grouping w/ amber "Pinned"/"Recent" section headers, amber left-rail + warm wash on pinned rows, inline pin badge + hover pin/unpin action (aria-pressed), persists across reload; ACTIVITY_META entries; also fixed stream-completion upsertChat that would have clobbered pinnedAt after every answer (now preserves existing row)
- FEATURE document.digest: Document.summary/summaryAt/summaryModel columns; POST/GET /api/v1/documents/:id/summary — grounded in the doc's own chunks (page-ordered, 24k-char budget), strict-JSON LLM w/ one retry, Zod DocumentSummaryPayloadSchema {overview, keyPoints≤10, entities≤12, suggestedQuestions≤3}, server-side cache (fresh-vs-updatedAt check, ?force=1 regenerate, 409 pre-index, VIEWER 403), usage events + audit document.summary; DigestSection card in inspector: generate/skeleton/cached states, key points w/ emerald checks, entity chips, "Ask →" suggested questions, copy-as-Markdown, regenerate, model+time+grounding footer
- BUG (found during verification): digest "Ask →" with no active chat lost the prefill — ChatPanel (the only composerPrefill consumer) isn't mounted in the empty state. Lifted auto-create into ChatView (nonce-guarded createChat + setActiveChat); verified full loop: Ask → auto chat → composer prefilled → grounded streamed answer w/ citation
- FEATURE prompt.library: composer BookMarked popover (localStorage insightdoc-prompts, ≤50) — save current draft w/ optional title (default = draft head), click-to-insert w/ caret-to-end focus, per-row delete, count badge, empty state; loads lazily on open (no SSR mismatch, no setState-in-effect)
- STYLE: digest card top gradient sheen + hover glow on ask rows; pinned-row warm wash overrides; nowrap message counts; amber Pinned header; prompt-row hover + saved-flash emerald tint
- VERIFIED via agent-browser: pin→persist(reload)→unpin cycle (light+dark), digest generate (11.1s POST 200, persisted) + cached GET on reopen, Ask→flow E2E w/ grounded answer (28% recurring revenue cited p.3), prompt save→insert→clear cycle, activity feed shows "pinned a conversation"/"generated an AI digest"/"unpinned a conversation", mobile 390px (composer row: prompt+mic+textarea+send fits, segmented panes intact), dark+light themes, smoke suite 13/13 in 8.9s, lint clean, tsc src-clean, dev.log clean (no recurring 403s)

Stage Summary:
- Platform now: 5 views + palette + inspector w/ AI digest + turn actions + rename/pin mgmt + scanned-PDF taxonomy + mobile layout + feedback loop + voice I/O + follow-ups + de-dup + review queue + self-healing workspace lifecycle + personal prompt library
- Known risks: (1) restart dev server after schema/Prisma-client or src/server/worker/* changes (recurring); (2) digest context capped at 24k chars — very large docs summarize the first ~6k tokens of chunk order (acceptable v1; could map-reduce later); (3) prompt library is per-browser (localStorage) by design — not shared across devices; (4) dev server died silently once during the round (no trace in log, likely sandbox OOM) — restart recovered; watch for recurrence
- Suggested next round: OCR adapter (tesseract.js) behind flag for [SCANNED_PDF]; map-reduce digest for >24k-char docs; share digest to chat as a message; per-message feedback in exports UI parity; chat message virtualization for 100+ message sessions

---
Task ID: cron-review-8 (round 9)
Agent: orchestrator (Z.ai Code)
Task: Status assessment, browser QA, OCR fallback engine (scanned PDFs), document tags, map-reduce digest, styling pass

Work Log:
- QA first (agent-browser): all 5 views healthy, lint + tsc src-clean on arrival → platform stable → proceeded to the pipeline's biggest remaining gap
- FEATURE ocr.fallback (flagship): new src/server/worker/ocr.ts — unpdf renderPageAsImage (@napi-rs/canvas backend) at 2× scale per page → singleton tesseract.js v7 worker (eng, lang data cached under .tesseract-cache/); bounds: INSIGHTDOC_OCR_MAX_PAGES (default 12), INSIGHTDOC_OCR=0 disables; per-page progress callback maps 22→32% in the ingestion bar. Worker Stage 2.5 rewritten: scanned detection now branches to OCR instead of dead-ending; recovered text continues the normal chunk→embed pipeline; ocrPages persisted; OCR_FAILED taxonomy if tesseract itself errors; too-little-text (<12 chars/page avg) still fails as SCANNED_PDF w/ honest copy; audit 'document.ocr'
- BUG (bundler): tesseract.js crashed in Next runtime — `Cannot find module '/ROOT/node_modules/tesseract.js/src/worker-script/node/index.js'` (webpack rewrites __dirname) AND threw repeated uncaughtExceptions from the worker thread. Fixed via serverExternalPackages: ["tesseract.js", "@napi-rs/canvas"] in next.config.ts (native/worker-script modules must not bundle). ALSO found the sandbox has NO fonts for canvas text rendering (fillText drew only digits!) — @napi-rs/canvas needs GlobalFonts.registerFromPath; scripts/assets/DejaVuSans.ttf added (757KB)
- TEST FIXTURE: scripts/make-scanned-pdf.ts — image-only PDF (canvas-drawn text → JPEG → hand-built minimal PDF w/ DCTDecode XObject, zero text layer); verified extractText = 0 chars; OCR round-trip confidence 92, word-perfect recovery
- OCR E2E VERIFIED: upload scanned.pdf → "no text layer — starting OCR fallback" → "OCR page 1/1: 928 chars" → COMPLETED (1 chunk, 274 tokens, ocrPages=1) → scoped RAG answer cites the OCR'd snippet with correct figures ($1.42B / 610M / 43%) — the pipeline now indexes scans end-to-end
- FEATURE document.tags: Document.tags TEXT (JSON string[]) + parseDocumentTags(); UpdateDocumentSchema +tags (≤8, ≤24 chars, lowercased); PATCH /documents/:id dedupes + audits 'document.tag'; shared TagEditor popover (chips w/ remove, Enter/comma to add, workspace-vocabulary suggestions most-used-first, dirty-gated save, saved-flash); library: row tag chips (≤3 + "+n"), workspace tag-vocabulary filter row w/ usage counts (OR semantics, active glow, Clear), tag icon action per row; inspector: tags row + editor; ACTIVITY_META 'document.tag'; api-client setDocumentTags/updateDocument tags param
- FEATURE document.ocr badge: DocumentDTO +ocrPages; library rows get cyan OCR chip (scanline sweep animation, tooltip "recovered via OCR on N pages"); inspector gets an "OCR-recovered document" notice bar (ScanLine + artifact caveat); pipeline sidebar step 2 now says "→ OCR fallback (tesseract)"; ACTIVITY_META 'document.ocr'
- FEATURE digest.map-reduce: summary route detects context truncation (>24k chars) → splitParts (≤4 × ≤20k) → per-part terse bullet notes (LLM) → reduce digest from notes + retained beginning; promptTokens now charged on the full digest context; non-truncated path unchanged (single-shot)
- STYLE: doc-tag chip hover lift + primary glow; tag-filter active glow + press scale; OCR badge scanline sweep; filter-row layout; tag editor saved-flash
- Verified: tags add→save→chips→filter("finance" → only scanned doc)→clear; OCR badge + inspector notice render; mobile 390px (tag rows wrap, no overflow); smoke 13/13 in 9.4s; lint clean; tsc src-clean; fresh browser session zero console errors

Stage Summary:
- The ingestion pipeline no longer dead-ends on scanned PDFs: detect → OCR (tesseract, bounded) → index → cited answers. Documents gained analyst tags (edit/filter) and OCR provenance badges; digests now scale to large docs via map-reduce
- Known risks: (1) restart dev server after schema/Prisma/worker changes (recurring — done this round); (2) OCR caps at 12 pages — longer scans index only the first 12 (ocrPages badge shows count; audit detail notes truncation); (3) OCR accuracy depends on scan quality (confidence 92 on the fixture; blank/rotated scans fail honestly); (4) dev server died silently TWICE this session (no log trace, likely sandbox OOM) — restart recovers; watch for recurrence; (5) map-reduce digest path is code-verified but only triggers on >24k-char docs (current fixtures are small); (6) .tesseract-cache (~15MB lang data) lives in project root — add to .gitignore if repo-ified
- Suggested next round: OCR progress surfacing in the documents-table status cell ("OCR page 2/9…" copy via errorMessage-less progress); map-reduce digest smoke fixture (generate a >24k-char PDF); share digest to chat as a message; workspace-level tag management (rename/merge); chat message virtualization

---
Task ID: cron-review-9 (round 10)
Agent: orchestrator (Z.ai Code)
Task: Status assessment, browser QA, digest share-to-chat (note messages), live OCR/ingestion phase copy, workspace tag management, map-reduce digest fixture + E2E, export fix, styling pass

Work Log:
- QA first (agent-browser): all 5 views healthy, lint clean, tsc src-clean, smoke 13/13 on arrival, zero console errors → platform stable → proceeded to round-9's suggested roadmap (no blocking bugs)
- FEATURE digest.share (flagship): POST /api/v1/documents/:id/summary/share — posts the CACHED digest into chat as a persisted role='note' message (new 4th role in ChatMessageDTO); body {sessionId?} targets an existing same-workspace chat or auto-creates "Digest — <doc title>" (≤120); 409 when no cached digest ("generate one first"); content = DigestNoteContent JSON {kind, documentId, documentTitle, digest, model, generatedAt}; notes are EXCLUDED from LLM transcripts (stream route filters user/assistant only — verified: grounded answer streamed fine in a note-bearing chat); RBAC all members incl. VIEWER (annotation-style); audits digest.share (+chat.create when auto-creating)
- UI DigestMessageCard: gradient note card in chat (Sparkles avatar chip, header w/ doc title + date, overview, ≤6 key points w/ emerald checks + "+N more in the inspector" hint, entity chips, suggested-question rows with Ask→ composer prefill, model footer + "Open source document" jump); corrupt-JSON fallback renders a muted placeholder; hover actions = copy-as-Markdown only (notes immutable — no feedback/narrate/regenerate); inspector DigestSection gained Share-to-chat (header icon + full-width CTA) which shares, closes the dialog, activates the chat, seeds messages and switches views with toast
- FEATURE ocr/ingestion live phase copy: Document.statusDetail column (db:push + restart per recurring gotcha); processor sets human phase text per stage — "Queued → starting extraction" / "Reading stored file" / "Extracted N pages — checking text layer" / "Scanned PDF detected — OCR page i/N (tesseract)" / "Chunking text (1000/200 sliding window)" / "Embedding chunks i/total (1536-dim)"; cleared on COMPLETED/FAILED; surfaced through documents list + status poll + upload toDto; library status cell renders it under the progress bar as animated shimmer-text with spinner; VERIFIED live on a fresh scan upload: 22% "Extracted 1 page…" → 32% "OCR page 1/1 (tesseract)" → 100% clean
- FEATURE workspace tag management: POST /api/v1/workspaces/:id/tags {action:'rename'|'delete', from[, to]} — MEMBER+; rename rewrites the tag on every tagged doc (dedupe merges into an existing target, 8-tag cap respected); delete strips everywhere; per-doc audits document.tag.rename/delete; library tag-filter row gains a "Manage" button (hidden for VIEWER) opening a dialog: vocabulary rows with proportional usage bars + doc counts, inline rename (Enter/Esc, disabled when unchanged), two-step delete confirm with rose danger wash; store upserts all returned docs + active filters remapped (rename) / pruned (delete); VERIFIED E2E: scanned-demo→scanned renamed w/ toast, dialog + row chips + filter vocabulary updated live
- FIXTURE+VERIFY map-reduce digest: scripts/make-large-pdf.ts (arg: output [pages], default 40 → ~31k chars, 4 seeded section templates) + scripts/verify-map-reduce.ts (upload → poll → force digest → share sanity → cleanup); 26-page fixture (~20k chars) correctly used the single-shot path; 40-page fixture TRIGGERED map-reduce: dev.log shows "[digest] mapped part 1/2" + "2/2", digest 51.6s, 7 keyPoints/10 entities/3 questions — the >24k path is now proven end-to-end; make-scanned-pdf.ts gained a variant-stamp arg (unique content hash per QA run — first statusDetail test was correctly blocked by duplicate detection)
- BUG FIX (caught by new smoke checks, HIGH): documents/[documentId] GET+PATCH still built DocumentDTO without statusDetail → Zod safeParse failed → 500 "Document data corrupt" on EVERY star/rename/tags PATCH; fixed both parse sites; swept all DocumentDTOSchema construction sites (list/upload/tags/detail) — all include statusDetail
- FIX export: MD export dumped note JSON raw under "🤖 InsightDoc" — now renders a structured "📋 Shared AI digest — <title>" section (overview, key points, entities, suggested questions, model+time blockquote; verbatim fallback for corrupt payloads); JSON export is lossless w/ role 'note' (verified note,user,assistant)
- SMOKE extended to 15 checks: +workspace tag rename applied (smoketag→risk) and +digest shared to chat as note (role=note, kind:digest content); 15/15 passing in ~14-16s
- STYLE: .note-card (rise-in entrance, top sheen, hover glow, question-row glow), .shimmer-text (sweeping gradient text for live status), .tag-usage-bar/.tag-mgmt-row (hover nudge + data-danger rose wash), .digest-share-btn/.digest-share-cta (primary tint, lift + glow), ACTIVITY_META entries for digest.share ("shared an AI digest into chat"), document.tag.rename, document.tag.delete — all three verified rendering in the dashboard feed
- Cleanup: deleted the leftover crashed-smoke workspace (the smoke crash had skipped its cleanup — suite exits non-zero before cleanup on check crashes, workspace leaked; deletion via API)
- Verified: fresh browser session zero console/page errors; light+dark themes (note card + tag manager + library screenshots in download/); mobile 390px (tag row wraps w/ Manage button, no h-overflow); MD/JSON exports; Alt-nav; dev.log clean after fixes

Stage Summary:
- Platform now: 5 views + palette + inspector w/ AI digest (now shareable into chats as rich note cards) + turn actions + rename/pin mgmt + scanned-PDF taxonomy w/ live OCR phase copy + mobile layout + feedback loop + voice I/O + follow-ups + de-dup + review queue + self-healing workspaces + prompt library + workspace-wide tag governance (rename/merge/delete w/ audit) + proven map-reduce digest for large docs
- Known risks: (1) restart dev server after schema/Prisma/worker changes (recurring — done this round); (2) note messages are conversation artifacts: immutable by design (no regenerate/feedback), excluded from LLM context, but count toward session message counts; (3) digest share always creates a dedicated chat from the inspector — the API already accepts sessionId for a future "share into current chat" affordance; (4) map-reduce verified at 2 map parts (40-page fixture); the 4-part ceiling (>60k chars) shares the same code path but is untested; (5) smoke suite cleanup skips if a check crashes mid-run (workspace leak possible on failure — acceptable for a dev harness); (6) statusDetail copy assumes OCR_MAX_PAGES=12 default for the "i/N" bound
- Suggested next round: "Share into current chat" affordance from chat-view document chips (API ready); multi-document compare view (side-by-side digests); toast notification when ingestion completes in background; multi-page scanned fixture (watch OCR i/N tick live); chat message virtualization for 100+ message sessions; optional per-tag color accents in the library

---
Task ID: cron-review-10 (round 11)
Agent: orchestrator (Z.ai Code)
Task: Status assessment, browser QA, analytics chart fix, ingestion-completion toasts, digest share target picker (current chat), multi-document digest compare, styling pass

Work Log:
- QA first (agent-browser): all 5 views healthy, smoke 15/15 on arrival, lint + tsc src-clean, zero console errors → found 1 real rendering bug, platform otherwise stable → proceeded to roadmap features
- BUG FIX (charts, found during QA): analytics Y-axis tick labels were CLIPPED off the left edge — getBBox showed x:-4..-10 for "30000".."120000" (margin.left -18 + no formatter, 5-digit raw numbers wider than the 54px gutter). Fixed: formatCompactTokens (30k/60k/90k/120k, M for ≥1e6) on the token chart, formatCompactUsd ($0.07/$0.28, bare "0" at zero) on the cost chart, margin.left -18→-14 both charts. Verified: all tick x ≥ 7, labels fully visible light+dark
- FEATURE ingest-completion toasts: the 1.5s ingestion poll now diffs prev status → fires toast.success on PENDING/PROCESSING→COMPLETED ("<title> finished processing · N chunks indexed — now searchable and answerable" + View action → documents view) and toast.error on →FAILED (errorMessage/statusDetail as description + Details action → opens the inspector). Brand-new docs skipped (upload flow already toasts). Success toasts got a hairline emerald top border in globals.css. VERIFIED E2E: uploaded a fresh PDF → '"toast-test-3" finished processing / 8 chunks indexed' toast with View button; duplicate upload correctly 400-rejected by checksum dedup meanwhile
- FEATURE digest share target picker: DigestSection header Send button → DropdownMenu when a chat is active ("Share into current chat <title>" w/ MessageSquare icon vs "Share into a new chat <Digest — title>" w/ MessageSquarePlus); no active chat → direct share (previous behavior). Bottom CTA became a split: "Share to current chat" + icon-only new-chat button. shareToChat(targetChatId?) passes sessionId (API was already ready); store update now APPENDS the note when sharing into the already-active chat (messages.length guard) instead of setMessages-wipe; active-chat detection via !createdChat && activeChatId===res.chat.id
- BUG FIX (route, caught by the share E2E): share route hardcoded messageCount:1 in the returned ChatSessionDTO → rail showed "1 messages" on a 16-message chat after share-into-current. Fixed with a real db.chatMessage.count. Server data was never harmed (reload showed 16). VERIFIED: share again → 17 messages, full history + note appended, toast '<title>' variant
- FEATURE digest compare (flagship): new digest-compare-dialog.tsx — Documents bulk bar gains "Compare digests" (visible when EXACTLY 2 rows selected) → store.compareDocIds [A,B] → side-by-side dialog: per-column digest (overview, numbered key points w/ staggered fade-in, entity chips, model+chunks+cached footer, per-column regenerate) with per-side state machine (loading/missing/error/ready incl. inline "Generate digest" for never-summarized docs); SHARED ENTITY HIGHLIGHT: module-level pub/sub publishes each loaded digest, chips present in BOTH docs get emerald ⇄ styling + tooltip, footer counts unique shared entities ("8 shared entities detected"); A/B badge + primary/cyan accent dots
- BUG FIX (layout, found in QA): Radix ScrollArea viewport (h-full) never scrolls inside a max-h dialog — percentage height can't resolve against an indefinite (max-height-only) height, viewport grew to content height 693px inside a 293px root. Replaced ScrollArea with a plain div min-h-0 flex-1 overflow-y-auto insightdoc-scroll
- FIXTURE: scripts/make-test-pdf.ts gained a variant arg (argv[3] stamps a unique QA line into page 1) so consecutive test uploads don't trip checksum duplicate detection
- STYLE: .digest-compare-btn (primary tint + lift + glow), .digest-compare-col (rise-in + top sheen gradient), .digest-compare-overview/.digest-compare-point (fade/stagger animations w/ per-row delay), .digest-compare-entity hover lift + emerald ring glow on shared state, sonner success-toast emerald top hairline
- MOBILE FIX (390px, found in QA): bulk action bar overflowed — "Delete selected" clipped off-screen when Compare digests joined the row. Container → flex-wrap with gap-y, "N selected" nowrap. Verified: bar wraps to 2 rows, all actions reachable
- Verified E2E via agent-browser: compare open → scroll → shared chips (16 emerald of 20 = 8 unique × 2 sides) → close; share dropdown (desktop) → into-current → 17 msgs; mobile compare stacks md:grid-cols-2 w/ internal scroll + footer pinned; mobile split CTA fits; light+dark themes on charts/dialog/bulk bar; keyboard search filter round-trip (type→0 rows→clear→5); smoke 15/15 in 14.2s; lint clean; tsc src-clean; zero console/page errors; dev.log clean; QA upload docs cleaned up

Stage Summary:
- Platform now: 5 views + palette + inspector w/ AI digest (shareable into CURRENT chat or a new one via target picker) + side-by-side MULTI-DOCUMENT DIGEST COMPARE with shared-entity highlighting + turn actions + rename/pin mgmt + scanned-PDF taxonomy w/ live OCR phase copy + ingestion completion/failure toasts + mobile layout + feedback loop + voice I/O + follow-ups + de-dup + review queue + self-healing workspaces + prompt library + tag governance + map-reduce digest
- Known risks: (1) restart dev server after schema/Prisma-client or src/server/worker/* changes (recurring; NOT needed for route/component changes — both hot-reloaded fine this round); (2) compare dialog shared-entity matching is exact-normalized-string — "Milwaukee" vs "Milwaukee manufacturing plant" count as different entities (v1 honest behavior; could add containment matching later); (3) compare requires cached digests — never-summarized docs show inline generate buttons (~10s each); (4) toast on FAILED ingestion is code-verified only (no failing fixture this round); (5) bulk-bar wrap puts actions on a 2nd row at <sm widths (cosmetic)
- Suggested next round: chat message virtualization for 100+ message sessions; per-tag color accents in the library; OCR multi-page fixture (watch i/N tick live); "compare digests" entry from search results / command palette; containment-based entity matching in compare; FAILED-ingestion toast fixture (e.g. corrupt PDF upload)

---
Task ID: R-responsive
Agent: orchestrator (Z.ai Code)
Task: Full-site fluid responsiveness audit + fixes; QA sweep; fix any bugs found

Work Log:
- Read worklog → platform mature (5 views + dialogs + split-screen). Plan: static grep audit → agent-browser overflow sweep at 320/390/768/1280/1920 × 5 views → fix → re-verify
- Built a JS overflow detector (eval'd via agent-browser): flags elements whose rect exceeds viewport outside an intentional scroll container; swept ALL 5 views at 5 widths (20 combos) — zero page-level overflow before AND after (app was structurally fluid), so focused on *quality* of responsiveness, which surfaced real problems via screenshots
- CRITICAL BUG (found by running scripts/smoke.ts during QA): upload route `src/app/api/v1/workspaces/[workspaceId]/documents/upload/route.ts` (156 lines) had been ACCIDENTALLY DELETED by the latest auto-snapshot commit 9bdfe22 — every upload (UI + API) returned 404 "Server action not found". Restored byte-identical from commit 5b72225 (`git show`), restarted dev server (stale .next), smoke now **15/15 in 20.1s** (upload→dedup→ingest 8 chunks→hybrid search→SSE grounded answer→feedback→star→tags→digest share→cleanup)
- FIX documents table (was the worst offender: titles truncated to 1–2 chars ≤768px because Size/Pages/Chunks/Status/Actions fixed widths ≈466px starved the flex title col): Size col `hidden md:table-cell`, Pages/Chunks `hidden lg:table-cell`, Status `hidden md:table-cell`; extracted `StatusBlock` component (badge+OCR+progress+statusDetail) rendered BOTH in the Status column (md+) and inline in the Document cell (`md:hidden`); added `md:hidden` meta line "7.4 KB · 8 pages · 8 chunks". Result: 390px shows full titles + inline status + actions; 768px shows 5 clean cols; lg+ unchanged 7 cols
- FIX pdf-viewer-panel (pages rendered at fixed 620×scale → clipped off-screen on mobile; toolbar ~404px of fixed controls overflowed 390px): (1) auto fit-to-width — ResizeObserver on the scroll container computes `fitScale=clamp((w−40)/620, 0.4, 1)`, `autoFit` default true, `effectiveScale=autoFit?fitScale:scale` used for Page + placeholders; zoom buttons disable autoFit; new "Fit page to width" toggle (Maximize icon, aria-pressed) re-enables; % readout shows effective scale (`hidden sm:block` to save space); (2) toolbar `flex-wrap` with left group `min-w-28 flex-1` (title keeps ≥112px) — wraps to 2 rows on phones. VERIFIED numerically: manual zoom 2× → page 1164→1348px + fit=false; Fit → 347px (= pane 390−43) + fit=true; narrow ResizablePane 467px at 1280 viewport → page 423px (observer reacts to pane resize, not just viewport)
- FLUID POLISH: container padding `p-5 lg:p-8` → `p-4 sm:p-5 lg:p-8` (7 containers, 4 views); h1 fluid type — documents/search/analytics `text-xl sm:text-2xl`, dashboard hero `text-2xl sm:text-3xl`; search header row `flex-wrap` + icon `shrink-0` (top-k badge no longer crushes title); document-detail-dialog title `line-clamp-2` on mobile (was hard truncate mid-word) with sm:truncate
- Verified E2E: 20/20 view×width overflow checks clean (320/390/768/1280/1920); docs table screenshots at 390/768/1920 + light theme 1280; PDF fit at 390 + in-pane at 1280; zoom/fit toggle state assertions; smoke 15/15; `bun run lint` clean; dev.log clean after restart
- QA artifacts in /tmp/qa-shots/ (docs-{390,768,1920,320}, pdf-{390,1280}, light theme)

Stage Summary:
- Site is now fluid end-to-end: phone 320–390 (mobile table w/ inline status+meta, 2-row PDF toolbar, fit-to-width pages), tablet 768 (5-col table, sidebar shell), desktop 1280–1920 (full 7-col table, resizable panes with per-pane PDF fit), light+dark
- CRITICAL regression fixed: upload route restored — uploads work again (was broken by snapshot commit 9bdfe22; anyone restoring from git should check that commit)
- Known risks: (1) auto-snapshot commits can silently delete files — `git log --stat` before blaming code; (2) PDF fitScale clamps at 0.4 minimum (extremely narrow panes <290px will still scroll horizontally — acceptable); (3) manual zoom persists per panel mount, resets on document change; (4) smoke test data fully cleaned up
- Suggested next round: chat message virtualization (100+ msgs); per-tag color accents; OCR multi-page fixture; compare-digest entry from search results/command palette; containment entity matching in compare; FAILED-ingestion toast fixture (corrupt PDF); persist per-document zoom level in localStorage

---
Task ID: R-production
Agent: orchestrator (Z.ai Code)
Task: Production-grade readiness — docs (README/LICENSE/env/gitignore/etc), Vercel deployment prep, SEO/metadata/AI-discoverability (OpenGraph, icons, logo, JSON-LD), GitHub-push readiness

Work Log:
- AUDIT: git repo on main (auto-snapshot commits); found .env + db/custom.db + storage/uploads/*.pdf + .tesseract-cache + eng.traineddata + download/ + tool-results/ + upload/ ALL TRACKED (secret/data leak for GitHub push); src/ type-clean but tsconfig swept non-product dirs (examples/skills/scripts errors); z-ai-web-dev-sdk reads NO env vars — only a .z-ai-config JSON file from disk (cwd/home//etc) → every AI route (stream/summary/TTS/ASR/followups) would 500 on Vercel's read-only FS
- CRITICAL FIX (serverless AI): new src/server/zai.ts — getZAI() env-aware bootstrap (ZAI_API_KEY+ZAI_BASE_URL → new ZAIClient(config) via typed cast because SDK .d.ts marks constructor private; else SDK file-based create()); process-cached; migrated all 6 call sites across 5 routes; smoke 15/15 proves the refactor works (grounded answer still streams)
- SEO layer: layout.tsx full Metadata API — metadataBase (NEXT_PUBLIC_SITE_URL ?? https://insightdoc.vercel.app), title template, 15 keywords, OG (website/url/siteName/locale), twitter summary_large_image, robots (googleBot max-image-preview:large/max-snippet:-1), canonical "/", appleWebApp, formatDetection; viewport gains viewportFit:cover + light/dark themeColor pair + colorScheme
- STRUCTURED DATA: page.tsx JSON-LD — SoftwareApplication (featureList, offers $0, MIT license link) + FAQPage (3 Qs incl. scanned-PDF + self-host) — targets Google rich results + ChatGPT/Perplexity citations
- AI/SEARCH DISCOVERABILITY: app/robots.ts replaces static robots.txt (explicitly allows GPTBot/OAI-SearchBot/ChatGPT-User/ClaudeBot/PerplexityBot/Google-Extended/CCBot/Amazonbot/meta-externalagent; disallows /api/; sitemap+host refs); app/sitemap.ts; public/llms.txt (llmstxt.org) + public/ai.txt (machine-readable site description)
- BRAND KIT (generated, not hand-pixeled): authored public/brand/logo-mark.svg (slate tile + document + emerald insight spark) + og-image.svg (1200×630: badge, wordmark, tagline, 4 feature chips, footer) → scripts/build-brand-assets.ts (sharp + png-to-ico, `bun run brand`) emits app/icon.svg, app/icon.png(512), app/apple-icon.png(180), app/favicon.ico(16/32/48), app/opengraph-image.png + twitter-image.png, public/icons/icon-{192,512}.png; fixed OG eyebrow-pill overflow (330→412px) after visual inspection
- PWA: app/manifest.ts (name/short_name, standalone, #0F172A, any+maskable icons)
- CONFIG HARDENING: next.config.ts — security headers on all routes (X-Content-Type-Options, X-Frame-Options SAMEORIGIN, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy mic=(self) for voice input), Cache-Control no-store on /api/*, poweredByHeader:false, typescript.ignoreBuildErrors:false (strict builds), standalone now OPT-IN via BUILD_STANDALONE=1 (Vercel builds its own output); tsconfig excludes examples/skills/scripts/tool-results → `bunx tsc --noEmit` FULLY CLEAN
- SERVERLESS FX: maxDuration exports verified/added (upload/stream/search/followups/transcribe/speech already had them; added process+summary at 60s)
- package.json → insightdoc@1.0.0: description/license MIT/repo placeholders (YOUR_USERNAME to fill)/engines node>=20.9/postinstall prisma generate (Vercel-critical)/typecheck+smoke+brand scripts; build split: `build` (portable, Vercel) vs `build:standalone` (self-host)
- DOCKER: Dockerfile (bun builder → node:20-slim runner, standalone, openssl for Prisma, db:push at build → boot-ready SQLite baked into image, VOLUMES /app/db + /app/storage) + docker-compose.yml (named volumes, healthcheck via node fetch, env/env-file hooks) + .dockerignore — NOTE untested in sandbox (no docker), standard standalone pattern
- REPO HYGIENE: .env.example (fully commented: DATABASE_URL w/ Prisma relative-path gotcha, NEXT_PUBLIC_SITE_URL, ZAI_*, INSIGHTDOC_OCR*); .gitignore +db/*.db +/storage/ +.tesseract-cache +eng.traineddata +tool-results +download +agent-ctx +upload; git rm -r --cached the leaked set (incl. .env!); db/.gitkeep (SQLite dir must exist on clone); 3 QA screenshots curated → docs/assets/ for README
- DOCS SUITE: README.md (badges, feature table, ASCII architecture, quickstart, env table, scripts, deploy summary, prod checklist, structure); LICENSE (MIT); CONTRIBUTING.md (quality bar: lint+typecheck+smoke, commit style); SECURITY.md (private reporting + hardening table: auth/upload/headers/AI creds); CHANGELOG.md (1.0.0 + unreleased); docs/DEPLOYMENT.md (honest matrix: Vercel-as-is=ephemeral SQLite/reads-only, Vercel+Postgres recipe w/ pooler note, storage-swap notes, Docker/compose, bare metal, post-deploy verification, troubleshooting); docs/ARCHITECTURE.md (pipeline/retrieval/data model/swap-point table/trade-offs); docs/API.md (full endpoint reference + SSE frame contract + curl example)
- vercel.json: minimal {framework:nextjs} (zero-config deploy; per-route maxDuration instead of risky fn glob patterns)

Verification:
- bun install ok (png-to-ico pinned); `bun run lint` clean; `bunx tsc --noEmit` FULLY CLEAN
- dev server restarted (next.config+package.json changes); 10/10 endpoints 200: / /robots.txt /sitemap.xml /manifest.webmanifest /llms.txt /ai.txt /opengraph-image.png /favicon.ico /icon.svg /apple-icon.png
- rendered HTML verified: title/description/canonical(=metadataBase)/og:title/og:image/twitter:card/JSON-LD/manifest/icon/apple-icon/robots meta all present; security headers present on responses; og:image shows localhost in DEV (documented Next dev behavior — prod resolves via metadataBase/VERCEL_URL; canonical proves metadataBase wiring)
- smoke suite 15/15 in 20.8s post-refactor (upload→dedup→ingest 8 chunks→hybrid search→SSE grounded answer→feedback→star→tags→digest share→cleanup)
- agent-browser: page title correct, dashboard renders w/ live data (5 docs/20 chunks/12 convos) at 390 + 1440, zero console errors, dev.log clean
- committed: 60a4585 "release: v1.0.0" (90 files, +1575/−13304)

Stage Summary:
- InsightDoc v1.0.0 is production-ready + deployable: Vercel (zero-config app; Postgres recipe for durable persistence — documented honestly incl. SQLite read-only limitation), Docker/compose (full functionality), bare metal. SEO/AI-discoverability complete (OG/Twitter cards w/ generated brand art, JSON-LD, AI-crawler robots, llms.txt/ai.txt, PWA manifest). Repo is GitHub-push-ready: secrets/runtime data untracked, MIT license, docs suite, CI-friendly scripts (lint/typecheck/smoke, postinstall prisma generate)
- TO PUSH TO GITHUB: user fills YOUR_USERNAME placeholders in package.json (repository/homepage/bugs) + README/CONTRIBUTING clone URLs (or `git remote add origin <url>` && `git push -u origin main`); Vercel needs env: DATABASE_URL, NEXT_PUBLIC_SITE_URL, ZAI_API_KEY, ZAI_BASE_URL
- Known risks: (1) Dockerfile/compose untested in sandbox (no docker available) — standard standalone pattern, low risk; (2) Vercel-as-is: UI + chat/search work until first write attempt (SQLite read-only FS) — DEPLOYMENT.md is explicit about this and gives the Postgres path; storage.ts swap needed for durable original-PDF bytes on serverless; (3) og:image absolute URL relies on NEXT_PUBLIC_SITE_URL being set in prod env; (4) repo history still contains previously-committed .env (sandbox-only DATABASE_URL, no secrets) — fine for private repos, consider git-filter-repo before public push; (5) icon.svg serves 200 but tab-icon rendering not visually verifiable in headless screenshots (favicon.ico verified 200 + valid ICO bytes)
- Suggested next round: optional Postgres+Blob adapter implementation (code, not just docs); GitHub Actions CI (lint+typecheck+smoke on PR); auth (NextAuth) for public deployments; update YOUR_USERNAME placeholders once the GitHub repo URL is known
