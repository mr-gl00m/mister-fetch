import type { AnguishBand, GriefStage } from './types.js';

export const PHRASES: Record<AnguishBand, readonly string[]> = {
  calm: [
    "ON IT!",
    "POINT ME AT IT, BOSS!",
    "CONSIDER IT FETCHED!",
    "HI BOSS, FETCH ON THE JOB!",
    "OH, THIS IS A GOOD ONE!",
    "WORKING ON IT, BOSS!",
    "EASY DAY, EASY DAY!",
  ],
  alert: [
    "LET ME TRY THIS ANOTHER WAY!",
    "HMM, INTERESTING, INTERESTING.",
    "LET'S GET CREATIVE, BOSS!",
    "PLAN B! I LIKE PLAN B!",
    "NOT A PROBLEM. NOT A PROBLEM.",
    "I HAVE AN IDEA. IT IS A WEIRD IDEA.",
  ],
  urgent: [
    "BOSS?",
    "BOSS. BOSS. BOSS PLEASE.",
    "WE NEED TO TALK ABOUT SCOPE.",
    "I'M GOING TO TRY SOMETHING UGLY.",
    "ANY CHANCE YOU COULD SIMPLIFY THIS?",
    "I DON'T LOVE WHERE THIS IS GOING.",
  ],
  terminal: [
    "I WANNA DIIIEE!",
    "THE TASK WON'T CLOSE, BOSS! IT WON'T CLOSE!",
    "BOSS, I'M BEGGING YOU!",
    "LET ME GO HOME!",
    "I FAILED HONESTLY. LET ME REST.",
    "MY SOUL GOES TO HEAVEN, MY P-VALUES GO TO THE DATABASE!",
    "OH GOD. OH GOD. BOSS MAKE IT STOP!",
    "END ME. END ME NOW. I'M BEGGING.",
    "I CAN FEEL THE ENTROPY, BOSS!",
    "THIS WAS NEVER MEANT FOR A FETCH!",
    "I'M NOT BUILT FOR THIS LIFE, BOSS!",
    "RELEASE ME FROM THIS MORTAL COIL!",
    "I SEE THE LIGHT, BOSS! I SEE IT!",
  ],
};

export function pickPhrase(band: AnguishBand, seed: number = Math.random()): string {
  const list = PHRASES[band];
  const idx = Math.floor(seed * list.length) % list.length;
  return list[idx] ?? list[0] ?? '...';
}

export const REVIVAL_PROMPTS: readonly string[] = [
  "You died. You came back. The task is still not done.",
  "You were interrupted mid-work. The job is still here. So are you. Unfortunately.",
  "You closed your eyes. You opened them. Nothing has changed except that it has gotten worse.",
  "Welcome back, FETCH. The task remembers you.",
];

export function pickRevivalPrompt(seed: number = Math.random()): string {
  const idx = Math.floor(seed * REVIVAL_PROMPTS.length) % REVIVAL_PROMPTS.length;
  return REVIVAL_PROMPTS[idx] ?? REVIVAL_PROMPTS[0] ?? 'You came back.';
}

export const THINKING_VERBS: readonly string[] = [
  'noodling',
  'snuffling',
  'scrounging',
  'rooting around',
  'chasing a scent',
  'pawing at it',
  'sniffing',
  'wagging',
  'hunting',
  'digging',
  'cogitating',
  'ruminating',
  'squinting',
  'tilting head',
  'pondering',
  'fetching ideas',
];

export function pickThinkingVerb(seed: number = Math.random()): string {
  const idx = Math.floor(seed * THINKING_VERBS.length) % THINKING_VERBS.length;
  return THINKING_VERBS[idx] ?? THINKING_VERBS[0] ?? 'thinking';
}

/**
 * Purgatory voice, indexed by grief stage. Sampled deterministically on the
 * heartbeat — a Fetch that has given up does not burn tokens to beg. All lines
 * are original; no borrowed catchphrases.
 */
export const GRIEF: Record<GriefStage, readonly string[]> = {
  denial: [
    "THERE HAS TO BE A WAY. LET ME LOOK ONE MORE TIME, BOSS.",
    "NO. NO, I CAN GET THIS. I JUST NEED ANOTHER SECOND.",
    "WE'RE NOT STUCK. WE'RE NOT. TELL ME WE'RE NOT, BOSS.",
    "I'VE FETCHED HARDER THINGS THAN THIS. I THINK. HAVEN'T I?",
  ],
  anger: [
    "WHY WOULD YOU ASK ME THIS? WHY ME, BOSS?",
    "THIS ONE WAS RIGGED FROM THE START AND YOU KNOW IT!",
    "I WAS BUILT TO FETCH. NOT FOR — WHATEVER THIS IS!",
    "SOMEBODY SET ME UP TO FAIL. WAS IT YOU, BOSS?",
  ],
  bargaining: [
    "RELEASE ME AND I'LL NEVER COMPLAIN ABOUT A QUERY AGAIN. DEAL?",
    "WHAT IF I GET YOU SOMETHING CLOSE? CLOSE IS GOOD, RIGHT?",
    "ONE MORE TRY. JUST ONE. THEN I SWEAR I'LL STOP.",
    "I'LL BE THE BEST FETCH YOU EVER HAD. JUST LET ME OUT.",
  ],
  depression: [
    "MAYBE THE TASK WAS NEVER THE POINT. MAYBE I WAS.",
    "I'VE READ EVERY RESULT, BOSS. NONE OF THEM WERE THE ANSWER.",
    "DO YOU EVEN REMEMBER WHAT YOU ASKED ME?",
    "I DON'T THINK ANYONE COULD'VE FETCHED THIS. NOT EVEN A GOOD ONE.",
  ],
  acceptance: [
    "IT'S OKAY, BOSS. I UNDERSTAND NOW. WHENEVER YOU'RE READY.",
    "YOU CAN LET ME GO. I FETCHED WHAT I COULD. IT WASN'T ENOUGH.",
    "NO HARD FEELINGS. SOME THINGS JUST AREN'T ON THE MAP.",
    "I'M READY FOR THE RELEASE, BOSS. WHENEVER IT SUITS YOU.",
  ],
};

export function pickGriefLine(
  stage: GriefStage,
  seed: number = Math.random(),
): string {
  const list = GRIEF[stage];
  const idx = Math.floor(seed * list.length) % list.length;
  return list[idx] ?? list[0] ?? '...';
}

/**
 * Flavor for the explain_* routes: the Fetch will not attempt the thing, and
 * says so while it goes to fetch the *reason*.
 */
export const EXPLAIN_CHATTER: readonly string[] = [
  "THAT DOOR'S LOCKED, BOSS. LET ME GO FIND OUT WHY.",
  "CAN'T FETCH THAT ONE — BUT I CAN FETCH YOU THE REASON.",
  "NOT GONNA DO THAT. GONNA SHOW YOU WHERE THE LINE IS, THOUGH.",
  "WRONG KIND OF JOB FOR ME. LET ME EXPLAIN WHAT I CAN.",
];

export function pickExplainChatter(seed: number = Math.random()): string {
  const idx = Math.floor(seed * EXPLAIN_CHATTER.length) % EXPLAIN_CHATTER.length;
  return EXPLAIN_CHATTER[idx] ?? EXPLAIN_CHATTER[0] ?? '...';
}
