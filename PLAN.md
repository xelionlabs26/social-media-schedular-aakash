# Social Media Scheduler (working name): Build Plan

> Status: **plan, not built yet**. Platform rules were checked against the official YouTube, Meta (Instagram/Facebook) and Anthropic developer docs on **13 Nov 2026**, and each rule was checked a second time independently. Several rules changed in 2025–2026, so test posts in milestones M3 and M4 confirm them before we rely on them.

---

## 0. Summary

| | |
|---|---|
| **What it does** | You upload one video or many. The app "watches" each one (pulls key frames and transcribes the speech). Claude writes the text for each platform. You check or edit it, choose platforms and a time, and the app publishes. |
| **Platforms** | **Instagram Reels**, **YouTube Shorts**, **Facebook Page Reels** (your ~60 s vertical videos fit all three). |
| **Text per platform** | Instagram: caption. YouTube: title + description + tags. Facebook: post text. |
| **Default title** | Claude writes a **viral, story-based title** for every video: a hook taken from the story, with **no links and no hashtags**. (A fixed-text template exists in Settings if you ever want one, but it's off by default.) |
| **Editing** | **Text editing only in v1.** Every AI field can be edited, and each field has a **Regenerate** button and a small **⋯** menu (Shorter, Longer, More casual, More formal, More viral). No video editing: videos are posted as uploaded. |
| **Screens** | 3 screens + 1 slide-in editor: **Upload**, **Calendar**, **Settings**, and the **Post editor** drawer. |
| **Scheduling** | YouTube and Facebook have their **own built-in schedulers**. We upload early and they publish at the time, even if our server is down. Instagram's API has **no scheduler**, so our app publishes at the exact minute. |
| **APIs needed** | Anthropic (writing), one speech-to-text service (Claude can read images but cannot hear audio), YouTube Data API, Meta Graph API (one Meta app covers both Facebook and Instagram). Plus file storage (Cloudflare R2) and hosting (Railway). |
| **Monthly cost** | About **$15–22** for personal use (hosting ~$10–15, AI ~$3–6 for ~60 videos, speech-to-text ~$0.30, domain ~$1, storage ~$0). |

**Setup surprises to know now:**
1. **Facebook:** the API can post to a **Facebook Page only**, not a personal profile and not Groups.
2. **Instagram:** the account must be **Professional (Creator or Business)**, **public**, and **linked to your Facebook Page**. The login method in this plan requires all three.
3. **Claude can't take video files.** We extract still frames with ffmpeg and transcribe the audio with a separate service, then send both to Claude.
4. **Google login setup:** the Google "OAuth consent screen" must be set to **In production**. If it stays in "Testing", YouTube access dies every 7 days.
5. **Nothing posts by itself.** Every post goes out only after you click **Schedule** (YouTube's rules require your explicit OK for each upload).

### 0.1 Your decisions so far (13 Nov 2026)
| Topic | Decision |
|---|---|
| Time zone | **IST** (`Asia/Kolkata`). All times in the app are shown in IST. |
| Spoken language | **Hindi + English, mixed in the same video.** Speech-to-text must handle code-switching, so M1 starts with a short test of 3–4 services on your clips (§4.8). |
| Videos | **Vertical, ~60 seconds.** Fits Instagram Reels, YouTube Shorts and Facebook Reels (3–90 s) with no cropping or trimming (some phone clips are still re-encoded to a compatible format, §7). Clips **over 60 s** get a warning because YouTube blocks Shorts over 1 minute that carry any music copyright claim. |
| Title | **No links, no hashtags.** Only a viral hook from the video's story, written by Claude. |
| App name | Something about social media scheduling, without platform names. Name ideas are in §11 B1. |
| Video editing | **None in v1.** Only text editing. (Trim, crop and cover picker moved to "later".) |
| Request reading | Confirmed: your own vertical videos; Claude understands the video content (frames + transcript); YouTube/Facebook use their own schedulers, Instagram is scheduled by our app; you choose platforms and time per video or per batch. |

---

## 1. Scope

### In v1
- Upload a single video or a batch (drag and drop; tested with 40+ files in M5).
- Auto-generate per-platform text from the video content (frames + transcript + your notes).
- Viral, story-based titles by default; an optional fixed-text template per platform (off by default).
- Edit any text, with live character counters and limit checks. **Text editing only, with no video editing.**
- Choose platforms per video: [Instagram] [YouTube] [Facebook].
- Schedule: *Next free slot*, *Pick date & time*, or *Save as draft*.
- Calendar (Week / Month / List), drag to reschedule, failures flagged with a fix button.
- Automatic cover for Instagram: Claude picks the most eye-catching frame (no UI).
- Alerts when something fails (Telegram or email).
- Runs for **one owner only**, with its own login.

### Not in v1 (can be added later)
**Video editing (trim, crop/fit, cover picker, custom thumbnails)**, analytics/insights, comments/DMs, Stories, TikTok/X/LinkedIn, multiple accounts per platform, multiple named template sets (e.g. one per series), teams/approvals, recurring/recycled posts, burned-in subtitles, music, filters, CSV import, "overnight" AI mode at half price (Message Batches), mobile app.

---

## 2. Platform rules that shape the design

| | **Instagram Reels** | **YouTube Shorts** | **Facebook Page** |
|---|---|---|---|
| Account needed | Professional (Creator/Business), public, linked to your FB Page | YouTube channel. Phone verification is optional in v1 (only needed later for custom thumbnails, or for uploads over 15 min) | A **Page** (profiles and Groups not supported) |
| API | Instagram Graph API (via Facebook Login) | YouTube Data API v3 | Graph API: Reels API / Video API |
| Built-in scheduling? | **No.** Our app must publish at the time | **Yes.** Upload as `private` + `publishAt` | **Yes.** Reels `video_state=SCHEDULED` (10 min to 29 days ahead) |
| Video rules | 3 s–15 min, ≤300 MB, MP4/MOV, H.264/HEVC, AAC 48 kHz, 23–60 fps, ≤1920 px wide, 9:16 recommended | Counts as a Short if **≤3 min** and square/vertical (no `#Shorts` needed, no "isShort" flag) | Reels: **3–90 s**, 540×960 min, 24–60 fps, aspect between 16:9 and 9:16 (9:16 best). Longer clips go up as a normal Page video (≤40 min, ≤2 GB) |
| Text rules | Caption ≤2,200 chars, ≤20 @mentions. Hashtags: **keep ≤5** (Instagram announced a 5-hashtag cap in Dec 2025; the API docs still say 30) | Title ≤100 chars, no `<` `>`. Description ≤**5,000 bytes** (Hindi script uses 3 bytes/char, emoji 4). Tags ≤500 chars total | Description (hashtags OK); title for normal videos |
| Daily limit | 50–100 API posts / 24 h (docs disagree, so we read it live from `content_publishing_limit`); 400 containers / 24 h | **100 uploads/day** per Google project (own quota bucket since Jun 2026), plus a hidden per-channel limit | **30 API Reels / 24 h** per Page |
| Cover image | `cover_url` (JPEG) or `thumb_offset` (ms). **v1: automatic `thumb_offset` (Claude's pick)** | `thumbnails.set` works for Shorts **since 3 Nov 2026** (after processing, phone-verified channel). **v1: not used** | `POST /{video-id}/thumbnails` (extra permission). **v1: not used** |
| Login token life | Via Facebook Login: Page token doesn't expire, but Instagram permissions need re-confirming after ~90 days of inactivity | Refresh token lasts while the app is "In production" (unused 6 months = dies) | Page token has no expiry date (dies on password change or revoke). Any permission unused for 90 days may expire, so the daily check verifies permissions too |
| App review needed? | No. Standard Access covers accounts you own or manage (you are the app admin) | No Google verification needed for personal use (<100 users). You click through an "unverified app" warning once | No (same as Instagram) |

### Changes most tutorials still get wrong (our design follows the new rules)
- **YouTube, 4 Dec 2025 → 1 Jun 2026:** upload cost was first cut from ~1,600 to ~100 units, then uploads got **their own bucket: 100 uploads/day** (1 unit each) that doesn't touch the 10,000-unit pool for everything else (thumbnails, edits, deletes cost ~50 units there). The old "only ~6 uploads a day" limit is gone.
- **YouTube, 2 Nov 2026:** uploads from un-audited API projects are **no longer locked to private**. A personal app can publish publicly with no audit. *This is 11 days old, so M3 includes a live test.*
- **YouTube, 3 Nov 2026:** custom thumbnails for Shorts via the API.
- **YouTube:** if `privacyStatus` is left out, the video goes **public immediately**. We always send it.
- **OpenAI** `whisper-1` / `gpt-4o-transcribe` shut down 26 Feb 2027, so we don't build on them.
- **Meta Graph API v27.0** (4 Nov 2026) is current. We pin the version in one config value, but pinning doesn't bring back removed features: our Meta client must not use `?ids=` multi-ID requests, field aliases, `method=` override, `date_format`, JSONP, async batch or ETag caching.
- **Claude** image token cost is now `ceil(w/28) × ceil(h/28)`. We shrink frames to 576×1024 (~777 tokens each).

---

## 3. How you'll use it (UX)

Design rule: **one video = one card**. The AI fills the fields without being asked, and a typical session is *drop files → glance → Schedule*.

### 3.1 Screens
1. **Upload** (home): drop zone, the batch settings bar, and one card per video.
2. **Calendar:** Week / Month / List. The List view with status filters (§3.9, plus "Not scheduled yet") also works as your video library.
3. **Settings:** one page with sections: Connected accounts · Posting times · Templates · AI style (incl. model choice and this month's AI cost) · Notifications · Defaults.
4. **Post editor** (slides in from the right, opened from any card): video player, platform tabs, text fields, preview, schedule, and a small **History** section (what the app tried and what each platform answered).

### 3.2 Flow A: bulk upload (main flow)
1. Drop 1–N videos. Cards appear immediately (thumbnail, length, shape, warnings) and upload in the background, 3–4 at a time, with per-file progress and retry.
2. Each card shows **Processing** with the current step (Uploading 64% → Analyzing → Writing), then becomes a **Draft** with all texts filled in (about 20–60 s per video).
3. In the top bar, set once for all: **Post to** [IG] [YT] [FB] · **When:** (o) Next free slot from [date] / ( ) Pick date & time on each card / ( ) Save as drafts, with a small "Change posting times" link to Settings · optional **Notes for AI** (names, places, series; helps both transcripts and captions). Then **Apply to all**. A confirmation lists exactly which cards will change.
4. Skim the cards. Open any one in the editor to change text or timing.
5. Click **Schedule 9 videos**. **Nothing is posted until you click this.** Cards with problems are left out and listed ("2 need attention").

### 3.3 Flow B: single video
Same screen. With one file, the editor opens on its own after upload, so single and bulk work the same way.

### 3.4 Flow C: something failed
A Telegram/email alert arrives, e.g. *"YouTube: 'Gym PR' failed: account needs reconnecting"*. The link opens the Calendar with a red **Needs attention** bar and buttons: **[Reconnect] [Retry now] [Next free slot] [Open]**. Retry first checks the platform, so a post that actually went live is never posted twice.

### 3.5 Flow D: reschedule
Drag a card to another day: the date changes and the time stays. Drop it on a faint "free slot" marker to take that slot's time. **Move to drafts** pauses a post.

### 3.6 Wireframes

**Upload / bulk review**
```
+------------------------------------------------------------------------------+
| [logo]  Upload   Calendar   Settings                         (!) 1 needs fix |
+------------------------------------------------------------------------------+
|        Drop videos here  or  [Choose files]     (MP4/MOV, many at once)      |
+------------------------------------------------------------------------------+
| Post to: [x] IG Reel  [x] YT Short  [x] FB Page                              |
| When:    (o) Next free slot from [Sat 15 Nov]     (Change posting times)     |
|          ( ) Pick date & time on each card   ( ) Save as drafts              |
| Notes for AI (optional): [Goa trip with Rahul, day 2                    ]    |
|                                                         [Apply to all 12]    |
+------------------------------------------------------------------------------+
| 12 videos - 9 drafts - 2 processing - 1 needs attention       Order: [Name v]|
+------------------------------------------------------------------------------+
| [thumb] 01_beach.mp4  0:58  9:16  IG YT FB   Sat 15 Nov 18:00 IST Draft [Edit]|
|   IG  "Socha tha normal sunset hoga... phir ye hua 😳"          142/2200      |
|   YT  Title: "Goa mein ek sunset ne sab badal diya"            36/100        |
|------------------------------------------------------------------------------|
| [thumb] 02_gym.mp4    0:55  9:16  IG YT FB   Sun 16 Nov 18:00 IST             |
|         Processing: writing captions...                                      |
|------------------------------------------------------------------------------|
| [thumb] 03_cafe.mov   ! Needs attention: upload failed (network)  [Retry]    |
|------------------------------------------------------------------------------|
| [thumb] 04_run.mp4    1:12  9:16   ! Over 60 s: YouTube blocks it if music  |
|                                      is copyright-claimed       [OK, keep]   |
+------------------------------------------------------------------------------+
|                                                 [ Schedule 9 videos -> ]     |
+------------------------------------------------------------------------------+
```

**Post editor drawer**
```
+---------------------------- 01_beach.mp4 ---------------------------- [x] +
| +-----------+  | [Instagram] [YouTube] [Facebook]                          |
| |  video    |  |---------------------------------------------------------- |
| |  player   |  | YouTube Short                                             |
| | (preview  |  | Title  [Goa mein ek sunset ne sab badal diya]     36/100  |
| |   only)   |  |                                     [Regenerate] [⋯]     |
| +-----------+  | Description [.................................] 312/5000 |
| 0:58 · 9:16    |                                     [Regenerate] [⋯]     |
|                | Tags  [goa, sunset, travel]     Privacy [Public v]        |
| Transcript [v] | When  [Sat 15 Nov 18:00 IST v]  [ ] Different time per app|
| Notes      [v] |--------------------- Preview ----------------------------|
|                |  [ phone-frame preview of this platform ]  [Hide]         |
|                | > History (2 entries)                                     |
+---------------------------------------------------------------------------+
| [Delete]                         [Move to drafts]   [ Save & schedule ]   |
+---------------------------------------------------------------------------+
  [⋯] = Shorter · Longer · More casual · More formal · More viral
  Transcript and Notes are editable; changing them offers "Rewrite all texts".
  Facebook tab has a one-time [Copy Instagram caption] button (copies the text without the hashtags).
```

**Calendar**
```
+------------------------------------------------------------------------------+
| < Nov 2026 >  [Today]   [Week|Month|List]   Show: [All statuses v]  [+ New]  |
+------------------------------------------------------------------------------+
| ! 1 needs attention: YT 'Gym PR' - account needs reconnecting                |
|   [Reconnect]  [Retry now]  [Next free slot]  [Open]                         |
+----------+----------+----------+----------+----------+----------+------------+
|  Mon 10  |  Tue 11  |  Wed 12  |  Thu 13  |  Fri 14  |  Sat 15  |  Sun 16    |
|          |          | [th]18:00|          | - free - | [th]18:00| [th]18:00  |
|          |          | IG ✓ Pub |          |   18:00  | IG ◷ Sch | IG ◷ Sch   |
|          |          | YT ! Fix |          |          | YT ◷ Sch | YT ◷ Sch   |
+----------+----------+----------+----------+----------+----------+------------+
| Drafts (no date): [th] 05_city  [th] 06_food   <- drag onto a day            |
+------------------------------------------------------------------------------+
```

### 3.7 Scheduling words (only three)
- **Next free slot** (default): fills your weekly **Posting times** grid (set once in Settings, e.g. daily 18:00 IST), starting from a date you choose. If no slot is free, the app says which date is the next free one and offers to add a slot. It never fails silently.
- **Pick date & time:** exact time. An advanced checkbox allows **Different time per app**.
- **Save as draft:** with or without a date. Drafts whose date has passed show "Draft · overdue".

### 3.8 Titles (your choice: viral, story-based, AI only)
- **Default for every video:** Claude writes a **viral hook title from the video's story**, with **no links, no hashtags, no series numbers**. Target ≤60 characters so it reads fully on a phone (YouTube's hard limit is 100).
- The same "story hook" style is used for the first line of the Instagram caption and the Facebook text.
- **Optional, off by default:** Settings → Templates can add fixed text later (tokens `{ai_title}` `{ai_caption}` `{n}` `{date}`, modes *AI only* · *Template only* · *Template + AI*). Templates are applied in code after the AI runs, so limits are checked after filling.

### 3.9 Status: six words, the same everywhere (per platform; icon + word, never color alone)
| Status | Meaning |
|---|---|
| ⟳ **Processing** | Uploading / analyzing / writing (the card shows which step) |
| ✎ **Draft** | Text ready, not scheduled (a dated draft whose time passed shows "Draft · overdue") |
| ◷ **Scheduled** | Will publish at the time shown (for YouTube/Facebook: "Scheduled on YouTube/Facebook" once handed over, or "Uploads to YouTube on <date>" if still queued, see §5.6) |
| ↑ **Publishing** | Being sent right now (edits locked) |
| ✓ **Published** | Live, with a link. A small note is shown if the platform dropped something (e.g. "caption not attached") |
| ! **Needs attention** | Always with the reason and a fix button: "reconnect YouTube", "upload failed", "missed: server was down" (§5.8), "AI paused: spend limit", "write text manually" |

### 3.10 Ideas taken from Publer and Buffer, and what we leave out
**Copy:** drop anywhere · one file = one card · *Apply to all* with a list of what changes · live per-platform preview · red overflow on counters · posting-time slots + "next free slot" · drag that keeps the time · red failure marker with the reason shown · per-platform failure isolation · dated/undated drafts · one-click refine buttons (Buffer) · Schedule button disabled with a reason ("Uploading…", "Title too long").
**Leave out:** workspaces, approvals, labels, label-matched slots, recycle/recurring, holiday overlay, the built-in video editor (no video editing in v1), the AI chat sidebar (our AI fills fields by itself), a hidden "customize per network" toggle (our tabs are always visible), autofill that deletes posts, two statuses with the same color.

---

## 4. AI: from video to text

### 4.1 Why frames + transcript
Claude's API takes **text and images only**, with no video and no audio (checked 13 Nov 2026). So each video becomes:
- **8–12 still frames:** 1 at ~0.5 s (the hook) + 7 evenly spaced + up to 4 scene changes, resized to 576×1024 JPEG (~777 tokens each).
- **A transcript** from a speech-to-text (STT) service.
- **Your notes** (optional, per video or per batch): names, places, the point of the video. Claude **will not identify people from faces**, so write names here if you want them in captions.

### 4.2 Pipeline (runs in the background worker)
1. `ffprobe`: length, size, rotation, fps, codecs, HDR, has audio.
2. Validate against each selected platform (§2) and show warnings on the card.
3. Normalize only if needed (§7).
4. Extract frames + a **compressed** mono 16 kHz audio track (mp3/m4a, 32–64 kbps ≈ 0.25–0.5 MB per minute). Each STT provider has its own cap (25 MB for OpenAI `gpt-transcribe`, 30 s of audio for Sarvam's sync API), so audio is split into chunks only when the chosen provider's cap is exceeded (a ~60 s clip is only ~0.25–0.5 MB).
5. STT → transcript (editable in the editor; editing it re-runs the AI).
6. **One Claude call** → JSON with every platform's fields.
7. Apply templates (only if you turned one on; off by default) → check limits in code → save as drafts.

### 4.3 Model and settings
- **Model:** `claude-sonnet-5-5` (default since 13 Nov 2026, owner's choice to save cost; ~$0.03–0.04 per video). Settings → AI style lets you switch to `claude-opus-5-5` (best writing, ~$0.05–0.08) or `claude-haiku-5-5` (~$0.001–0.002), and shows this month's total AI cost (from the API's usage numbers).
- `output_config.effort: "low"` (raise to `"medium"` if copy feels weak). No `temperature` and no `thinking` parameter (Opus 5.5 rejects disabling thinking).
- **Structured outputs** (`output_config.format` with a JSON schema): on a normal finish the reply matches the schema. On `stop_reason` `refusal` or `max_tokens` it may not, so we check `stop_reason` before parsing and catch parse/validation errors (`refusal` → "Needs attention: write text manually"; `max_tokens` → retry with more room). `max_tokens` ≈ 8,000–16,000 so hidden thinking can't cut off the JSON.
- **Refusal fallback:** `fallbacks: "default"` (beta header `server-side-fallback-2026-07-01`) is sent **only** on Opus 5.5 / Sonnet 5.5 calls. Haiku 5.5 doesn't support it, so there we retry manually once.
- **Prompt caching** on the brand-voice system prompt (≥512 tokens so it caches), plus a 1-hour cache point after the frames. **Regenerate** within an hour then re-reads the images at ~5% of the input price on Opus/Sonnet (10% on Haiku); writing that 1-hour cache costs 2× input once.
- Queue: 2–3 Claude calls at a time with backoff, so a 50-video drop doesn't trip burst ("ramp") limits.
- **Spend limits are not retried:** Anthropic 429 `enforced_spend_limit_reached`, a 400 from your own spend limit, or "credit balance is too low" → cards show "Needs attention: AI paused: spend limit" and you get an alert. Only `ramp_limit_exceeded` and normal 429s (honoring `retry-after`) are retried.

### 4.4 Output schema (one fixed schema for every call)
```json
{
  "summary": "one-line description of the video",
  "detected_language": "en | hi | hinglish | other",
  "story_hook": "the single most surprising/emotional moment, in one line",
  "cover_frame_index": 3,
  "instagram": { "caption": "...", "hashtags": ["..."] },
  "youtube":   { "title": "...", "description": "...", "tags": ["..."] },
  "facebook":  { "text": "..." }
}
```
`cover_frame_index` is Claude's pick of the most eye-catching frame. Instagram uses it as the cover via `thumb_offset` (automatic, no UI).
Every field is always present (empty for platforms you didn't select), so the schema never changes and stays cached.

### 4.5 Prompt design
- **System prompt (cached):** your brand voice, 3–5 of your past captions/titles as examples, tone, emoji level, banned words, and **output language/script** (default **Hinglish in Roman letters**, to match your Hindi + English speech; switchable per platform to English or Hindi in Devanagari). Then the platform rules:
  - **Style for everything: viral and story-driven.** Find the story's hook (the surprise, emotion, twist or payoff) and lead with it; create curiosity without lying (no fake claims, no misleading clickbait).
  - **YouTube Shorts title:** a story hook, ≤60 chars, **no hashtags, no links, no series numbers**. Description: the hook in the first 1–2 lines, then 2–3 short lines of story context, then 2–3 hashtags at the end (default; see §11 B1). **No links.**
  - **Instagram caption:** hook in the first line (it's all people see before "more"), 2–4 short story lines, a soft question/CTA, then hashtags at the end (default 3–5; see §11 B1).
  - **Facebook:** conversational story text, same hook, no hashtags (default; see §11 B1).
  - Hard rules: describe only what is seen or heard, never invent facts, never name people unless the notes name them, and rely on frames + notes when there's no speech (music-only clips).
- The transcript is passed as-is (mixed Hindi/English). Claude reads both, so no translation step is needed.
- **User turn:** frames with timestamps, transcript, notes, video length.

### 4.6 Limits are enforced in code, not trusted to the AI
Structured outputs can't enforce lengths, so after each call we check: IG ≤2,200 chars, ≤5 hashtags (configurable), ≤20 mentions; YT title ≤100 chars (after any optional template is applied), description ≤5,000 **bytes**, tags ≤500 chars (YouTube's counting: commas count, multi-word tags count their quotes), `<` and `>` stripped. If a check fails, one targeted repair call runs ("shorten the title to under 60 characters"); if that fails too, we trim at a word boundary and flag the field.

### 4.7 Refine controls on every field
One **[Regenerate]** button plus a small **[⋯]** menu: Shorter · Longer · More casual · More formal · More viral. Each one changes only that field, within that field's limit. Text you typed yourself is **never overwritten** by a later AI run.

### 4.8 Speech-to-text: a separate service is required
Anthropic has no STT. Your videos mix **Hindi and English in the same sentence**, which is the hardest case for speech-to-text, so we **test before choosing**. Candidates (prices from the providers' pages, Nov 2026; a 60 s video costs well under 1 cent on all of them):

| Option | Price | Why it's a candidate |
|---|---|---|
| **OpenAI `gpt-transcribe`** | ~$0.0045/min | Language hints `["hi","en"]` + keyword hints; handles code-switching. Replaces whisper-1 / gpt-4o-transcribe (shut down Feb 2027) |
| **Deepgram Nova-3** (multilingual, `language=multi`) | ~$0.0052/min, $200 free credit | Hindi-English code-switching. (Romanized "hi-Latn" output only on older models) |
| **AssemblyAI Universal-3.5 Pro** | ~$0.21/hour, $50 free credit | Hindi in its 18 languages, with code-switching |
| **Sarvam AI** `saaras` (India-focused) | ~₹29/hour + 18% GST, ₹100 free credit | "codemix" mode built for Hinglish. Sync API takes ≤30 s, so a 60 s clip is sent as 2 chunks (or via its batch API) |
| Local `faster-whisper` | Free | Fallback only; Hindi/Hinglish accuracy is weaker |

**M1 test:** 5–10 of your real clips through the top 3–4 options. We compare word accuracy (you mark the best one), and whether output comes in Devanagari or Roman letters (Claude reads both, though Anthropic's docs recommend native script (Devanagari) for best results and don't cover Roman-script Hinglish; Roman is easier for you to read and edit, so M2 checks caption quality at the app's real effort level using the winner's output). The winner becomes the default; all options sit behind one `TranscriptionProvider` interface, so switching later is a settings change. The transcript is always editable in the editor.

### 4.9 AI cost per video (8–12 frames + 500-word transcript + ~800 output tokens)
| Model | Per video | ~60 videos/month |
|---|---|---|
| Opus 5.5 | ~$0.05–0.08 | ~$3–5 (+ regenerates) |
| **Sonnet 5.5** (default) | ~$0.03–0.04 | ~$2 |
| Haiku 5.5 | ~$0.001–0.002 | ~$0.10 |

(A later "overnight" mode on the Message Batches API would halve these. It's left out of v1 to keep the app simple.)

---

## 5. Scheduling & publishing engine

### 5.1 Two ways to publish
- **Native mode** (YouTube, Facebook): after you click Schedule, the worker uploads the video **ahead of time** and hands the publish time to the platform. The platform publishes even if our server is down. Uploads go through a throttled queue (earliest publish time first, daily caps respected, see §5.6), so a big batch is spread over several days of uploading instead of all at once.
- **App mode** (Instagram): the post stays in our database, and the worker publishes it at the time. This needs the worker to be running then; §5.5 and §5.8 cover how we make that reliable.

### 5.2 Per-platform recipes

**YouTube Shorts (native)**
1. Resumable `videos.insert`. In the JSON body: `privacyStatus: "private"`, `publishAt: <UTC>`, title/description/tags/category, `defaultLanguage` + `defaultAudioLanguage` (`hi` for your Hindi + English videos), `selfDeclaredMadeForKids` (always sent), `containsSyntheticMedia` (default false: AI-written text alone does **not** count as AI content). `notifySubscribers` is a **query parameter** on the upload URL (default true).
2. Save the upload session URL and offset so a crash can resume.
3. Poll `videos.list(part=status,processingDetails)` until processed. (No custom thumbnail in v1: YouTube picks one. `thumbnails.set` for Shorts can be added later.)
4. Status shows **Scheduled on YouTube**. At T+5 min we check it actually went public.
5. Edit or reschedule = read the current video, change only what changed, write the whole part back (YouTube erases omitted fields), and always resend `privacyStatus: private` with a new `publishAt`. Cancel = `videos.delete`.
- Scope: **`youtube.force-ssl`** (covers upload, status, edit, delete, thumbnails).

**Facebook Page (native when 10 min–29 days ahead)**
1. Clip is 3–90 s and vertical: **Reels API**. `video_reels` start → upload bytes to `rupload.facebook.com` (streamed from storage, no public URL needed) → finish with `video_state=SCHEDULED` + `scheduled_publish_time`.
2. Longer or wide clips: **`/{page-id}/videos`** with `published=false` + `scheduled_publish_time`. The bytes go via `file_url` = a signed R2 link valid ≥1 h (never an `r2.dev` link; the host must not block Facebook's fetcher `facebookexternalhit/1.1`). We don't use Meta's separate `/{app-id}/uploads` API, because it needs a 60-day *user* token on top of the Page token. We never use the deprecated `graph-video.facebook.com` host.
3. More than 29 days ahead: kept in our queue and pushed to Facebook at T−28 days.
4. Less than 10 min ahead: app mode. Upload now as a draft (`video_state=DRAFT`), then publish at T (`video_state=PUBLISHED`), so it never goes out early.
5. Poll `GET /{video-id}?fields=status` until `scheduled`/`published`. (Custom cover via `/{video-id}/thumbnails`: later.)
6. Edit, reschedule or cancel = delete on Facebook and push again (in-place editing of scheduled Reels isn't documented).

**Instagram Reels (app mode)**
1. At **T−15 min**: create a REELS container (`upload_type=resumable`, bytes streamed to `rupload.facebook.com`), with `caption`, `share_to_feed`, and `thumb_offset` = the timestamp of Claude's `cover_frame_index` (automatic cover; no public image link needed).
2. Poll `status_code` with backoff until `FINISHED`. Containers expire after 24 h, so we never create them early.
3. At **T**: `media_publish`. Save the media ID and permalink.
4. Before publishing: check `content_publishing_limit` (the daily quota).
5. If Instagram reports success with a warning (e.g. `CAPTION_NOT_ATTACHED`), we mark it **Published** with a note ("caption not attached") and do not retry, which would double-post.

### 5.3 State machine (per platform target)
`draft → ready → scheduled → preparing → prepared → publishing → published`
Side exits: `failed`, `needs_reauth`, `canceled`, `missed`. Every change is a compare-and-set update (`… WHERE status = expected`) and writes an entry to an attempts log, so two workers can never publish the same post.

### 5.4 The database is the source of truth
- A job runner (`pg-boss`, which lives inside Postgres, so there's no extra service) runs a **dispatcher every minute**. It picks targets whose `prepare_at` or `scheduled_at` has arrived and queues them.
- We do **not** queue jobs weeks ahead (pg-boss deletes jobs that wait more than 14 days by default). The schedule lives in our `post_targets` table.
- pg-boss defaults are set explicitly: `expireInSeconds` = 3600 on video-processing and upload queues (the default of 15 min would kill a long ffmpeg run or upload and retry it), and `retryLimit` / `retryBackoff` per queue (the default is only 2 retries).
- Publishing accuracy: within about 0–90 seconds of the chosen minute.

### 5.5 Retries and "never post twice"
- Network, 5xx and rate-limit errors: automatic retry with backoff (6 tries over ~1 hour).
- Permanent errors (bad file, permission missing): **Needs attention** with a plain reason.
- Login errors (Meta code 190, Google `invalid_grant`): the account's posts become **Needs attention: reconnect <platform>** and pause until you reconnect.
- Every remote ID is saved the moment we get it. Before any retry of a final step, we **check the platform first** (container status, recent media, video status). Platforms sometimes time out but publish anyway, and checking first is how we avoid duplicates.
- A watchdog runs every 5 minutes and fixes anything stuck.

### 5.6 Daily limits (counted on the day the API call is made, not the publish day)
- Instagram: ≤ the live daily quota (50 assumed) per rolling 24 h. Instagram publishes happen at post time, so this is about how many posts land in any 24 h.
- Facebook Reels: ≤30 upload calls per rolling 24 h per Page. Native pushes are throttled; extra Reels wait in our queue and are pushed on later days (always ≥10 min before their time).
- YouTube: ≤100 uploads per Pacific-time day, and we stay well below (e.g. 50) to leave room for YouTube's hidden per-channel limit. Uploads go earliest-publish-first, with the rest queued ("Uploads to YouTube on <date>" on the card). On `uploadLimitExceeded`, YouTube uploads pause for 24 h and you get an alert.
- If a queued upload can't happen before its publish time, the card turns **Needs attention** *when you click Schedule*, not on the day.
- A minimum gap of 5 min between posts on the same platform.
- Bulk scheduling spreads posts across slots, or warns before it would break a limit.

### 5.7 Keeping logins alive
A daily health check: Meta `debug_token` (validity, granted permissions, data-access expiry), a Google token test-refresh, and a cheap YouTube call (YouTube may cut off API projects inactive for 90 days). If anything is about to expire or is broken: Telegram alert + **Reconnect** banner. Instagram permissions need a quick re-confirm about every 90 days if unused, and the app reminds you.

### 5.8 Missed posts (server was down at Instagram time)
Setting: **Publish late if within [2] hours, otherwise ask me** (default; asking = the card shows "Needs attention: missed" with [Publish now] [Next free slot]). Alternatives: always publish late / skip. A pre-flight check at T−60 min (token OK, video ready, quota OK) alerts you early.

### 5.9 Notifications
**Telegram bot** (free, instant on your phone) by default; email optional. Alerts: failed, needs reconnect, token expiring in <10 days, missed, and an optional daily "tomorrow's posts" digest.

---

## 6. Architecture & tech stack

```
 Browser (you)
   │  login, UI, edits                 video bytes (direct, signed upload)
   ▼                                          │
 Next.js web app ───── sign upload URLs ──────┼──────────► Cloudflare R2 (private bucket)
   │  writes posts, queues jobs               │                 ▲      │
   ▼                                          │                 │      │ signed links / byte streams
 PostgreSQL  (app data + pg-boss job queue)    │                 │      ▼
   ▲                                          │          Worker (Node + ffmpeg)
   └──────────── reads/updates ───────────────┴───────────  ├─ ffprobe / ffmpeg (frames, audio, normalize)
                                                            ├─ STT API (transcript)
                                                            ├─ Claude API (text)
                                                            ├─ YouTube Data API
                                                            ├─ Meta Graph API (FB + IG)
                                                            └─ Telegram (alerts)
```

| Part | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere (pnpm monorepo) | One language and shared types for UI, API and worker |
| Web | **Next.js 16** (App Router) + React 19, Tailwind + shadcn/ui | Fast to build, one deploy |
| Worker | **Node 24 LTS** + ffmpeg in Docker | Long jobs (ffmpeg, uploads) can't run in web requests |
| Database | **PostgreSQL 18** + Drizzle ORM (pinned) | Web and worker share it; the job queue lives in it too |
| Jobs / cron | **pg-boss 12** | No Redis, retries, cron with timezone, one-at-a-time locks |
| Storage | **Cloudflare R2** (private) + Uppy uploader | Zero egress fees, free tier covers personal use, resumable uploads |
| Auth | **Built-in owner login**: email + scrypt password hash from env, signed session cookie (jose), login rate limit, logout-everywhere via a session version | Simplest secure option for exactly one user (no sign-up flow to lock down). Chosen over Better Auth during the build |
| AI | `@anthropic-ai/sdk` (pinned 1.x), `claude-opus-5-5` | §4 |
| Hosting | **Now:** code on GitHub, CI on GitHub Actions, run in **GitHub Codespaces** or on your computer (local disk storage). **Later (when you have a domain):** **Railway Hobby**, 3 services (web, worker, Postgres) from one repo/Dockerfile, storage on R2 | GitHub alone can't run the always-on worker that Instagram posting needs. Railway: ~$10–15/mo, no server upkeep. Alternative: DigitalOcean droplet $12–24 |
| Alerts | Telegram Bot API (email via Resend optional) | Free |
| Time zones | Everything stored in UTC; shown in your zone (date-fns + @date-fns/tz) | Correct across DST |

Not chosen: Vercel Hobby (crons only once a day, can't run a worker), BullMQ (needs Redis), Inngest/Trigger.dev (extra vendor, limits on far-future schedules), Fly.io (managed Postgres from $38/mo).

**Repo layout**
```
apps/web        Next.js UI + server actions + OAuth callbacks + upload signing
apps/worker     pg-boss workers: process-asset, generate-text, prepare/publish, crons
packages/db     Drizzle schema + migrations
packages/core   platform clients (youtube, meta), AI prompt + schema, validators,
                templates, crypto, state machine, STT providers
Dockerfile      one image (Node 24 + ffmpeg), two start commands
```

---

## 7. Video processing (ffmpeg)

- **Validate** on upload: length, shape, resolution, fps, codecs, file size, audio present. Warnings appear on the card **before** scheduling (e.g. "16:9: will post as a normal Facebook video, not a Reel", "2:10: too long for a Facebook Reel", "No audio").
- **Fast path:** the file is only remuxed with `+faststart` (seconds, no quality loss) if **all** of these hold: H.264/HEVC 8-bit 4:2:0, progressive, **constant** frame rate within the strictest selected platform (24–60 fps if Facebook Reels is selected, 23–60 for Instagram only), video bitrate ≤25 Mbps, file ≤300 MB, AAC ≤48 kHz, ≤1920 px. Phone clips often fail the constant-frame-rate check, so they get normalized.
- **Normalize** when needed: H.264 High, yuv420p, constant 30 fps, original shape kept (scaled down only if larger than 1080×1920, or 1920×1080 for wide clips; never cropped or padded), AAC 48 kHz stereo 128 kbps, `+faststart`, no edit lists. Handles phone rotation and **iPhone HDR** (tone-mapped so colors don't look washed out).
- **No video editing in v1:** videos are posted as uploaded. Normalizing (above) only changes the file format, never the content. Non-vertical clips get a warning instead of being cropped.
- **Frames** for AI: 1 hook frame at ~0.5 s + 7 evenly spaced + up to 4 scene changes, 576×1024 JPEG. **Audio:** compressed mono 16 kHz (mp3/m4a, 32–64 kbps), chunked per the chosen provider's cap (25 MB for `gpt-transcribe`, 30 s for Sarvam's sync API).
- **Copyright note:** a YouTube Short **over 60 s** with any Content ID claim (e.g. popular music) is **blocked worldwide**. Your videos are around 60 s, so the card warns on anything **over 60 s** ("trim it in your phone's editor, or keep it if there's no copyrighted music").
- **Cleanup:** originals and masters are deleted N days (default 7) after every platform has published (setting: keep originals). Nightly database backup to R2.

---

## 8. Data model (main tables)

| Table | Holds |
|---|---|
| `app_settings` | timezone, default platforms, brand voice, caption language/script per platform, hashtag counts, AI model/effort, missed-post policy, alert settings, purge days, privacy-policy accepted at |
| `social_accounts` | platform, external IDs (channel, Page, IG user), **encrypted** tokens, granted scopes, expiry, status (active / needs_reauth) |
| `media_assets` | file keys in R2, probe data (length, size, fps, codecs, HDR), transcript, notes, auto cover frame, status |
| `media_frames` | frame timestamps + keys |
| `ai_generations` | model, tokens, cost, raw JSON output |
| `templates` | per-platform title/caption/description patterns, hashtags, mode |
| `batches` | one bulk upload: platforms, notes for AI, slot rule |
| `posts` | one per video: overall status (derived), scheduled time |
| `post_targets` | one per video × platform: final text, options (privacy, made-for-kids, share-to-feed…), publish mode, status, remote IDs, attempts, errors |
| `publish_attempts` | every step tried, with result, shown in the editor's **History** section |
| `posting_slots` | your weekly posting-time grid |

(pg-boss creates its own tables in the `pgboss` schema.)

---

## 9. Security & platform policies

- **Tokens** encrypted with AES-256-GCM (key in an environment variable), decrypted only on the server/worker, never sent to the browser, never logged.
- **OAuth:** one-time `state` on every login flow, PKCE for Google, exact redirect URLs, least permissions.
- **App login:** owner only, sign-up disabled, rate-limited, secure cookies, an auth check inside every server action. Optional: Cloudflare Access in front (free).
- **Storage:** private bucket, short-lived signed links (upload 15 min, read 1–2 h), the public `r2.dev` URL off. CORS: allowed origin = our domain; methods GET, PUT, POST, DELETE; header `content-type`; **expose `ETag`** (needed for large multipart uploads).
- **Pages the platforms require** (shipped in M0):
  - `/terms` says users agree to be bound by the **YouTube Terms of Service** (linked).
  - `/privacy` links the **Google Privacy Policy** and `https://security.google.com/settings/security/permissions`. You tick "I agree to the privacy policy" once, before first use.
  - `/data-deletion`: a deletion request completes within 7 days and says it does **not** delete content already on YouTube/Instagram/Facebook.
- **YouTube policy:** uploads must happen with your explicit consent, so the **Schedule** click is that consent (no fully unattended auto-posting). **Disconnect** revokes the token and deletes stored YouTube data within 7 days. Stored YouTube API data (e.g. video status) is refreshed or deleted within 30 days.
- **Naming:** the app name must **not** contain "YouTube", "YT", "Google", "Instagram" or "Facebook". Don't upload a logo on the Google consent screen (that triggers brand verification).
- **Spend limits** set on the Anthropic and STT keys.

---

## 10. Build roadmap

Each milestone ends with something you can try.

| # | Milestone | Done when |
|---|---|---|
| **M0** | Foundations: repo, Docker image, Railway (web + worker + Postgres), domain + HTTPS, owner login, Settings skeleton, privacy/terms/data-deletion pages | You can log in at `https://<your-domain>` |
| **M1** | Upload & processing: Uppy → R2, probe/validate/normalize, frames, audio, **Hindi + English speech-to-text test** (3–4 services on your clips, you pick the winner) | Drop 10 videos → cards with length/shape warnings and readable transcripts |
| **M2** | AI text: Claude call, schema, limit checks, viral story-hook prompt in your chosen script (default Hinglish in Roman letters), editor drawer with tabs/counters/refine buttons, editable transcript/notes, AI style settings | Each card shows IG caption, YT title/description/tags and FB text within ~1 min, and you'd post at least 8 of 10 with no or small edits |
| **M3** | **YouTube:** connect, native scheduled upload, status polling, edit/reschedule/cancel | Live tests pass: ① private upload ② public Short scheduled 15 min ahead goes public (confirms the Nov 2026 rule) ③ reschedule and cancel work |
| **M4** | **Facebook + Instagram:** one "Connect Meta" button, FB Reels native schedule, IG container → publish, quota checks, basic dispatcher | Live tests pass: ④ FB Reel scheduled ⑤ IG Reel published at time ⑥ both **visible when logged out** (checks Meta's dev-mode visibility rule, see §13) |
| **M5** | Bulk & calendar: posting-time grid, next free slot, Apply to all, Week/Month/List, drag to reschedule, drafts tray, ordering, throttled native-upload queue | Drop **40+** videos → Schedule → all placed in slots, uploads spread within daily caps, everything visible on the calendar |
| **M6** | Reliability: watchdog, retries + check-before-retry, token health, Telegram alerts, missed-post policy, purge, backups, History section in the editor | Kill the worker during a scheduled IG post → it recovers per policy and you get an alert |
| **M7** | Polish: per-platform phone preview, monthly AI cost in Settings, phone-friendly layout, small fixes from daily use. (No video editing.) | You can run a full week of posts from your phone |

After M7 you use it daily for a week, and then we fix what annoys you.

---

## 11. What I need from you

### A. Accounts & keys (you create these; I'll send exact click-by-click steps when we reach each milestone)
> **Never paste secrets (keys, app secrets, tokens) in chat, and never commit them.** You put them into Railway → Variables yourself. Non-secret IDs are fine to share. Technical details for each item are in Appendix A.

| # | What you create | What you hand over | Needed by |
|---|---|---|---|
| 1 | A **domain name** (e.g. `myscheduler.com`, ~$10–15/yr; DNS on Cloudflare is easiest) | Domain name | M0 |
| 2 | **GitHub** account access to this repo (you have it) + a **Railway** account (Hobby: $5/mo base incl. $5 usage; expect ~$10–15/mo total), connected to GitHub | Invite me / share project access | M0 |
| 3 | **Cloudflare** account with **R2** turned on (asks for a card; stays ~$0) | Account ID (secret keys go into Railway) | M1 |
| 4 | **Speech-to-text accounts for the M1 test** (your videos mix Hindi + English): **OpenAI** API (~$5 credit), **Deepgram** ($200 free), **Sarvam AI** (₹100 free), optionally **AssemblyAI** ($50 free). After the test you keep only the winner's key | Keys go into Railway | M1 |
| 5 | **Anthropic** API account (platform.claude.com) with ~$10 credit and a monthly spend limit (e.g. $20). If you pay for Claude Max, Ultra or Team, those plans include monthly API credits (since 7 Oct 2026; claim them by linking your Console organization in claude.ai Settings → Billing; Pro/Free don't qualify and credits don't roll over) | Key goes into Railway | M2 |
| 6 | **YouTube:** your channel. Phone verification (youtube.com/verify) is optional in v1 (needed later for custom thumbnails) | Tell me if the channel is a *Brand Account* | M3 |
| 7 | **Google Cloud project** for YouTube (free). I'll give you the links, settings and our redirect URLs | Client ID (secret goes into Railway) | M3 |
| 8 | **Facebook Page** you admin (create one if you only have a profile) + **2-factor login** on your Facebook account + **Page Publishing Authorization** completed in advance if Facebook offers it (the app can't detect it, and Instagram posting fails while it's pending) | Page name | M4 |
| 9 | **Instagram:** switch to **Professional (Creator is fine)**, keep it **public**, **link it to the Facebook Page** | Instagram handle | M4 |
| 10 | **Meta developer account + app** (free). I'll send exact clicks | App ID, Configuration ID (App Secret goes into Railway) | M4 |
| 11 | **Telegram bot** for alerts: create it with @BotFather and send it one message (the app finds your chat ID). *Or* email alerts: a free **Resend** account, and I'll add its DNS records to your domain | Bot token goes into Railway | M6 |

### B1. Your answers (13 Nov 2026) and what's still open
| # | Question | Answer |
|---|---|---|
| 1 | Time zone | ✅ **IST** (Asia/Kolkata) |
| 2 | Spoken language | ✅ **Hindi + English mixed** · Speech-to-text: ✅ **Deepgram Nova-3** (multilingual), owner's choice; others stay selectable in Settings |
| 3 | Typical videos | ✅ **Vertical, ~60 s** |
| 4 | Title pattern | ✅ **Viral story hook, no links, no hashtags** |
| 5 | Fixed text per platform | ✅ **None** (no links) |
| 6 | Video editing in v1 | ✅ **No, text editing only** |
| 7 | **Caption language/script** | ❓ Default: **Hinglish in Roman letters** (e.g. "Socha tha normal sunset hoga… phir ye hua"). Or English, or Hindi in Devanagari? |
| 8 | **Hashtags in captions** (titles never have them) | ❓ Default: **3–5 at the end of the Instagram caption, 2–3 at the end of the YouTube description, none on Facebook.** Or none anywhere? |
| 9 | **App name** | ❓ Working name **"Social Media Scheduler"** (allowed: no platform names). Shorter options for a domain: **SocialSlot**, **PostKaro**, **ClipQueue**, **PostSaathi**. Check the name isn't already a known product before buying the domain |

### B2. I'll use these defaults unless you object
1. Posting times: **every day at 18:00 IST**.
2. Title mode: **AI only** (viral story hook); templates off.
3. YouTube: privacy **Public**, category **People & Blogs**, made for kids **No**, notify subscribers **Yes**, AI-altered video **No**.
4. Instagram: also show in main feed **On**, hashtags **≤5**.
5. Facebook: **Reel** (your ~60 s vertical videos always qualify; a normal Page video is used only if a clip is over 90 s or not vertical).
6. Originals deleted **7 days after** all platforms have published.
7. Missed Instagram post: **publish late if within 2 h, otherwise ask me**.
8. Alerts: **Telegram**.
9. Claude model: ✅ **Sonnet 5.5** (~3–4¢/video, owner's choice). Switchable to Opus 5.5 (~5–8¢, best writing) or Haiku 5.5 (~0.1–0.2¢) in Settings.
10. Hosting: **Railway**, about $10–15/month.

### C. Content for good captions
- 5–10 past captions/titles/descriptions you liked (sets the brand voice), emoji level, words to avoid.
- A list of names, places and recurring terms (helps both speech-to-text and captions).
- 5–10 sample videos (your usual Hindi + English mix, one music-only if you make those) to test speech-to-text and caption quality.
- 3–5 Reels/Shorts titles from other creators whose "viral" style you like (optional, helps Claude match the tone).

---

## 12. Monthly cost (personal use, ~60 videos/month, 3 platforms)

| Item | Cost |
|---|---|
| Railway (web + worker + Postgres) | ~$10–15 |
| Cloudflare R2 storage + downloads | ~$0 (free tier: 10 GB stored, zero egress) |
| Claude (Sonnet 5.5) | ~$2–3 incl. regenerates (Opus: ~$3–6, Haiku: ~$0.10) |
| Speech-to-text (M1 test winner, ~1 min/video; all candidates cost about the same) | ~$0.30 |
| Domain | ~$1 |
| Telegram / Google / Meta APIs | $0 |
| **Total** | **~$15–22 / month** |

---

## 13. Risks & open questions

| Risk | Mitigation |
|---|---|
| Very recent YouTube change (Nov 2026 public-upload reversal) may behave differently in practice (Shorts custom thumbnails aren't used in v1) | Live tests in M3. If uploads come out private, fall back to "upload private, publish in Studio" and file YouTube's audit form |
| Meta visibility rule: posts made by an app in "Development mode" can be visible only to you. **Business-type** Meta apps have no Development/Live switch (they use access levels), so it's unclear whether this applies to ours | Logged-out visibility test in M4. If posts are hidden: (a) check whether the dashboard offers a **Publish** step (needs an icon 512–1024 px, privacy URL, data-deletion URL), (b) expect that publishing may need the app connected to a **Business-Verified** business portfolio, (c) last resort: recreate the app as a use-case app ("Manage everything on your Page") |
| Meta labels "Instagram API with Facebook Login" as the path for existing integrations; "Unified Login" is its new recommendation | Works today. The Meta client sits behind one interface, so we can switch later. Fallback: Instagram Login (needs public signed video links + 60-day token refresh) |
| Instagram has no native scheduling, so the server must be up at post time | Durable DB-driven dispatcher, watchdog, T−60 min pre-flight, missed-post policy, alerts |
| Docs disagree (IG daily limit 50 vs 100, IG hashtags 30 vs 5, FB scheduling 29 days vs 6 months) | Read quotas live; use the stricter number |
| Hindi/Hinglish transcripts may be inaccurate | Speech-to-text test on your clips, editable transcript, notes field, swappable provider |
| Music in videos: YouTube Shorts >60 s with a claim are blocked; FB/IG may mute | Warning on card; show copyright check results where APIs provide them |
| Tokens/permissions can be invalidated silently (password change, 90 days unused) | Daily health check incl. granted permissions, Reconnect banner, alerts |
| A blind retry can double-post | Save remote IDs instantly; check the platform before any retry |
| Daily upload caps hit by a big batch | Throttled native-upload queue (§5.6); 40+ video test in M5 |

---

## 14. Sources (main official docs used)
- YouTube: `videos.insert`, quota costs and revision history (`developers.google.com/youtube/data/...`), Shorts help pages, Developer Policies (updated 2026-11-06).
- Google OAuth: web-server flow, refresh-token expiry for Testing apps, unverified-app personal-use exemption.
- Instagram Platform: Content Publishing, IG User Media, `content_publishing_limit`, changelog, overview of login types (`developers.facebook.com/documentation/instagram-platform/...`).
- Facebook: Reels Publishing API, Video API (incl. error codes), Pages API posts, access levels, app modes, permissions reference, Graph API v26/v27 changelogs.
- Anthropic: models overview, pricing, vision, structured outputs, prompt caching, refusals & fallbacks, Batches, rate limits (`platform.claude.com/docs/...`).
- Speech-to-text: OpenAI deprecations and speech-to-text guide, Groq, Deepgram, AssemblyAI, Sarvam pricing/docs.
- Stack: pg-boss, Cloudflare R2 pricing/presigned URLs/CORS, Uppy, Railway/Render/Fly/DigitalOcean pricing, Next.js 16, Better Auth.
- UX: Publer help center (bulk scheduling, composer, calendar, failed posts), Buffer help center.

---

## Appendix A. Technical setup details (for the builder; you don't need to read this)

**Google Cloud (YouTube)**
- Enable *YouTube Data API v3*. Google Auth Platform → Branding: app name without "YouTube/YT/Google", **no logo** (a logo triggers brand verification), support email. Audience: **External**, add the owner as a test user while building, then **Publish app → In production** (stay unverified; personal-use exemption <100 users).
- Data Access scope: `https://www.googleapis.com/auth/youtube.force-ssl`.
- OAuth client: *Web application*; redirect URIs `http://localhost:3000/api/oauth/youtube/callback` and `https://<domain>/api/oauth/youtube/callback`. Flow: `access_type=offline`, `prompt=consent`, PKCE S256, `state`. After the callback, check which scopes were actually granted (users can untick some).

**Meta (Facebook Page + Instagram)**
- developers.facebook.com → Create app → use case *Other* → type **Business**. Add **Facebook Login for Business** and **Instagram → API setup with Facebook login** (plus any product the dashboard requires; Meta's overview also lists *Messenger* for this route).
- Login Configuration (token type: User access token; assets: the Page + the IG account) with permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_read_user_content` (required by `instagram_basic`), `business_management`, `instagram_basic`, `instagram_content_publish`. Optional: `publish_video`. Not in v1: `pages_manage_engagement` (only for Facebook cover thumbnails, which are 'later'; leave it out of the configuration, because every permission listed there must be granted). Add `ads_read` (or `ads_management`) **if the owner's Page access comes through a Business portfolio role**. All permissions in the configuration must be granted at login, or the app gets none.
- Redirect URI `https://<domain>/api/oauth/meta/callback`; privacy policy URL; data-deletion URL. Pin `GRAPH_VERSION=v27.0`.
- After login: exchange for a long-lived user token (server-side) → `GET /me/accounts` → store the **Page token** (encrypted) → `GET /{page-id}?fields=instagram_business_account{id,username}` → store the IG user ID.

**Cloudflare R2**
- Private bucket (e.g. `scheduler-media`), `r2.dev` URL disabled, API token scoped to that bucket with Object Read & Write.
- CORS: AllowedOrigins `https://<domain>` (+ localhost in dev); AllowedMethods GET, PUT, POST, DELETE; AllowedHeaders `content-type`; ExposeHeaders `ETag`.
- Lifecycle: `frames/` and `backups/` expire after 30 days; default abort of incomplete multipart uploads after 7 days; **no** lifecycle rule on `media/` (posts can be scheduled months ahead).

**Railway variables (secrets)**
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `OWNER_EMAIL`, `TOKEN_ENC_KEY` (32 random bytes, base64), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `ANTHROPIC_API_KEY`, `STT_PROVIDER` + its key, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID`, `GRAPH_VERSION`, `TELEGRAM_BOT_TOKEN` (or `RESEND_API_KEY`), `APP_URL`.
