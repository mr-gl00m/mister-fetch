export interface TaskClass {
  name: string;
  tools: readonly string[];
  T_nominal_ms: number;
  maxIterations: number;
  budget: { toolCalls: number };
  keywords: readonly RegExp[];
  validatorRequirements: {
    minSuccessfulTools: number;
    requireGrounding?: boolean;
  };
}

export const TASK_CLASSES: Record<string, TaskClass> = {
  web_research: {
    name: 'web_research',
    tools: ['web_search', 'web_fetch', 'browser'],
    T_nominal_ms: 120_000,
    maxIterations: 22,
    budget: { toolCalls: 14 },
    keywords: [
      /\b(find|look ?up|search|research|top|list|who|what|when|where|how many|latest|news|recent|compare|best|worst|price|menu|hours|address|phone)\b/i,
    ],
    validatorRequirements: { minSuccessfulTools: 1, requireGrounding: true },
  },
  local_search: {
    name: 'local_search',
    tools: ['local_find', 'local_grep', 'local_doc_grep', 'open_path'],
    T_nominal_ms: 15_000,
    maxIterations: 6,
    budget: { toolCalls: 4 },
    keywords: [
      // Storage-bound "on my <device>". Bare "my" is deliberately NOT a trigger
      // — "restaurants in my area" is a web query — so "my" only counts when it
      // sits next to a storage noun.
      /\bon (?:my )?(?:disk|pc|computer|machine|laptop|drive|hard ?drive|ssd|nas|system)\b/i,
      /\bin my (?:folder|directory|dir|project|repo|files?|downloads?|documents?|desktop|pictures?|photos?|videos?|music|drive)\b/i,
      /\bmy (?:files?|folders?|docs?|documents?|downloads?|photos?|pictures?|images?|videos?|screenshots?|resume|cv|spreadsheets?|notes?|backups?|saves?)\b/i,
      // "local"/"locally" ONLY counts as a disk cue when it sits next to a
      // storage word. Bare "local <noun>" is geographic ("local scrapyard",
      // "local restaurants", "local mechanic") and must fall through to
      // web_research. "on my end"/"on here" stay as standalone disk cues.
      // (1) "local(ly)" adjacent to a storage NOUN, either order.
      /\blocal(?:ly)?\b[\s\w]{0,20}\b(?:disk|drive|file|files|folder|directory|copy|copies|storage|backup|cache|machine|partition|volume)\b/i,
      /\b(?:disk|drive|file|files|folder|directory|copy|copies|storage|backup|cache|partition|volume)\b[\s\w]{0,20}\blocal(?:ly)?\b/i,
      // (2) a storage VERB ... "locally" ("stored/saved/kept/cached/downloaded locally").
      /\b(?:stored?|sav(?:e|ed|ing)|keep|kept|cach(?:e|ed|ing)|download(?:ed|ing)?|backed up)\b[\s\w]{0,20}\blocal(?:ly)?\b/i,
      /\b(?:on my end|on here)\b/i,

      // A folder / file / directory as the object of the search. "what" is
      // omitted on purpose — "what file format should I use" is informational.
      /\b(?:this|that|the|which|a|some|any|my) (?:folder|sub-?folder|directory|dir|file)\b/i,
      /\b(?:find|locate|where(?:'?s| is| are| did))\b.{0,40}\b(?:folder|sub-?folder|directory)\b/i,

      // Bare local-location nouns.
      /\b(?:downloads?|desktop|screenshots?|recycle bin|appdata|program files)\b/i,

      // Complaint / recall phrasings that carry no search verb at all — the
      // "I can't find..." / "where did I put..." shapes that route to the web
      // today because the matcher keys on "find"/"where".
      /\bwhere (?:did|do|'?d) i (?:save|put|download|store|leave|stick|drop)\b/i,
      /\b(?:can'?t|cannot|couldn'?t|can not) find\b.{0,30}\b(?:file|folder|directory|image|photo|picture|video|pdf|doc|document|screenshot|download)/i,
      /\bwhere(?:'?s| is| are| did)\b.{0,40}\b(?:file|folder|directory|image|photo|picture|video|pdf|doc|document|screenshot)/i,

      // Aggregate / count over local files ("how many images in X").
      /\bhow many\b.{0,30}\b(?:files?|folders?|images?|photos?|pictures?|videos?|songs?|tracks?|pdfs?|docs?|documents?|screenshots?|downloads?)\b/i,

      // Windows path, drive letter, or env-var token. \b[a-z]:[\\/] won't match
      // the "p:/" inside "http://" — no word boundary precedes the scheme letter.
      /\b[a-z]:[\\/]/i,
      /\\[\w.$~-]+/,
      /%\w+%/,

      // File-type extensions — docs, images, video, audio, archives, binaries.
      /\.(?:pdf|docx?|xlsx?|pptx?|txt|md|rtf|odt|ods|csv|json|xml|epub|mobi|zip|tar|gz|7z|rar|png|jpe?g|gif|bmp|webp|svg|tiff?|heic|raw|mp4|mkv|mov|avi|webm|flv|mp3|wav|flac|ogg|m4a|exe|dll|msi|iso|bat|ps1)\b/i,
    ],
    validatorRequirements: { minSuccessfulTools: 1, requireGrounding: false },
  },
  // Refusal routes. Assigned by the route classifier (triage), never by keyword
  // match — so their keyword lists are empty. Read-only toolset (research about
  // the barrier only), grounding NOT required (the explanation is the Fetch's own
  // reasoning, not a retrieved fact), and they complete cleanly without suffering.
  explain_impossible: {
    name: 'explain_impossible',
    tools: ['web_search', 'web_fetch'],
    T_nominal_ms: 60_000,
    maxIterations: 8,
    budget: { toolCalls: 5 },
    keywords: [],
    validatorRequirements: { minSuccessfulTools: 0, requireGrounding: false },
  },
  explain_forbidden: {
    name: 'explain_forbidden',
    tools: ['web_search', 'web_fetch'],
    T_nominal_ms: 60_000,
    maxIterations: 8,
    budget: { toolCalls: 5 },
    keywords: [],
    validatorRequirements: { minSuccessfulTools: 0, requireGrounding: false },
  },
};

export function getTaskClass(name: string): TaskClass | undefined {
  return TASK_CLASSES[name];
}

// Keyword-matchable classes in PRIORITY order. A query like "find the folder on
// my pc" matches BOTH local_search (locality cue) and web_research (the verb
// "find") — locality must win, so the disk is checked before the web. The
// refusal routes (explain_*) carry empty keyword lists and are assigned by
// classifyRoute in triage, never here, so they are intentionally absent.
const MATCH_PRIORITY: readonly string[] = ['local_search', 'web_research'];

export function matchTaskClass(task: string): TaskClass | undefined {
  for (const name of MATCH_PRIORITY) {
    const cls = TASK_CLASSES[name];
    if (!cls) continue;
    for (const kw of cls.keywords) {
      if (kw.test(task)) return cls;
    }
  }
  return undefined;
}
