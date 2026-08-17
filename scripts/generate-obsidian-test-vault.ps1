[CmdletBinding()]
param(
    [string]$VaultRoot = ".\ObsidianTestVault"
)

# 1. Clean slate for idempotency
if (Test-Path -LiteralPath $VaultRoot) {
    Remove-Item -LiteralPath $VaultRoot -Recurse -Force
}
$null = New-Item -Path $VaultRoot -ItemType Directory -Force

# 2. Helper to create files safely with UTF-8 (no BOM), compatible with
#    Windows PowerShell 5.1 where Set-Content has no -Encoding utf8NoBOM.
$summary = [System.Collections.Generic.List[PSCustomObject]]::new()
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Create-VaultFile {
    param(
        [string]$RelativePath,
        [string]$Content,
        [string]$TestPurpose,
        [switch]$IsEmpty
    )

    $fullPath = [System.IO.Path]::Combine($VaultRoot, $RelativePath)
    $parentDir = [System.IO.Path]::GetDirectoryName($fullPath)

    if (-not (Test-Path -LiteralPath $parentDir)) {
        $null = New-Item -Path $parentDir -ItemType Directory -Force
    }

    if ($IsEmpty) {
        $null = New-Item -Path $fullPath -ItemType File -Force
    } else {
        [System.IO.File]::WriteAllText($fullPath, $Content, $Utf8NoBom)
    }

    $fileInfo = Get-Item -LiteralPath $fullPath
    $summary.Add([PSCustomObject]@{
        RelativePath = $RelativePath
        Bytes        = $fileInfo.Length
        TestPurpose  = $TestPurpose
    })
}

# 3. Create non-markdown and hidden configuration files
Create-VaultFile `
    -RelativePath ".obsidian/app.json" `
    -Content "{}" `
    -TestPurpose "Excluded directory (.obsidian app settings)"

Create-VaultFile `
    -RelativePath ".obsidian/workspace.json" `
    -Content "{}" `
    -TestPurpose "Excluded directory (.obsidian workspace state)"

Create-VaultFile `
    -RelativePath ".trash/Deleted Idea.md" `
    -Content @"
---
tags:
  - archive/trash
  - scratchpad
created: 2026-08-01
---

# Discarded Knowledge Retrieval Idea

Considered building an automated browser history parser that dumps every visit directly to raw text files. Shelved in favor of structured ingest outlined in [[Kickoff]].
"@ `
    -TestPurpose "Excluded directory (.trash deleted notes)"

# 4. Create Daily Notes
Create-VaultFile `
    -RelativePath "Daily Notes/2026-08-10.md" `
    -Content @"
---
tags:
  - daily-log
  - deep-work
created: 2026-08-10
---

## Morning Focus
Started the week by reviewing architectural diagrams for the local vector indexer. Finalized the tokenization pipeline benchmarks and verified that cosine similarity ranking holds stable under concurrent read loads.

## Afternoon Session
Synced with the team on milestone deliverables for [[Kickoff]]. We identified two potential edge cases around nested folder permissions and resolved the metadata parsing strategy. Updated progress in [[Tasks]].

## Evening Reflection
Wrapped up with a 45-minute strength session, logged over in [[Workout Log]]. Skimmed through the latest reading recommendations in [[Reading List]].
"@ `
    -TestPurpose "Standard daily log (2-3 paragraphs)"

Create-VaultFile `
    -RelativePath "Daily Notes/2026-08-11.md" `
    -Content @"
---
tags:
  - daily-log
  - architecture
created: 2026-08-11
---

## Yesterday's Follow-up
Reflecting on the benchmarks from [[2026-08-10]], I decided to replace the synchronous file scanner with an event-driven filesystem watcher. This should significantly lower CPU utilization during bulk ingestion passes.

## Design Review
Spent the afternoon refining typography and responsive card layouts. Reviewed the new client draft specifications in [[Client Website (Draft) v2]] and left feedback regarding viewport contrast and safe-area margins.
"@ `
    -TestPurpose "Daily log referencing [[2026-08-10]]"

Create-VaultFile `
    -RelativePath "Daily Notes/2026-08-17.md" `
    -Content @"
---
tags:
  - daily-log
  - release
created: 2026-08-17
---

## Release Day Checklist
Today is dedicated to end-to-end sync verification. We are running compatibility suites across all edge cases including unicode paths, special punctuation characters, and near-limit payloads.

## System Verification
Cross-checked the task completion matrix in [[Tasks]] against historical milestones from [[Old Meeting Notes]]. Ran high-throughput indexing tests against [[Research Dump]] to ensure zero memory leaks.
"@ `
    -TestPurpose "Current date daily note"

# 5. Create Projects Notes
Create-VaultFile `
    -RelativePath "Projects/SaveSort Launch/Kickoff.md" `
    -Content @"
---
tags:
  - project/savesort
  - planning
  - strategy
created: 2026-08-05
---

# SaveSort Launch Kickoff

SaveSort is a private, search-first platform designed to ingest web resources, index them deterministically with hybrid embeddings, and enable instant retrieval through conversational and keyword queries.

## Core Milestones
- [x] Schema design and pgvector hybrid search RPC
- [ ] Multi-tenant RLS security verification
- [ ] Bidirectional Obsidian vault synchronization
- [ ] Performance stress testing under large document loads

Refer to [[Tasks]] for individual action items and execution timelines.
"@ `
    -TestPurpose "Project note with task list and hierarchy"

Create-VaultFile `
    -RelativePath "Projects/SaveSort Launch/Tasks.md" `
    -Content @"
---
tags:
  - project/savesort
  - checklist
  - operations
created: 2026-08-06
---

# Launch Readiness Checklist

Actionable tracking document supporting [[Kickoff]].

- [x] Configure PostgreSQL tsvector schema and GIN indexes
- [x] Implement Gemini 768-dimension vector embedding boundary
- [x] Set up Supabase RLS policies with auth.uid() isolation
- [x] Implement safe URL ingestion adapter with SSRF private IP validation
- [x] Build OAuth token exchange flow for connected external accounts
- [ ] Implement rate limiting on file sync webhooks
- [ ] Stress-test search latency using [[Research Dump]]
- [ ] Validate non-Markdown asset skipping against [[Reading List]]
- [ ] Review retrospective action items in [[Q4 Review]]
- [ ] Finalize production release announcement
"@ `
    -TestPurpose "Markdown checklist with 10 task items"

Create-VaultFile `
    -RelativePath "Projects/日本語プロジェクト/概要.md" `
    -Content @"
---
tags:
  - プロジェクト
  - 国際化
  - ナレッジベース
created: 2026-08-12
---

# 日本語プロジェクト概要

本プロジェクトは、知識管理システムにおけるマルチバイト文字およびUnicodeパスの正規化処理を検証するための仕様書です。

## 主な検証項目
1. **パス処理の堅牢性**: 日本語のディレクトリ名およびファイル名が文字化けせずに同期されること。
2. **全文検索と形態素解析**: 日本語テキストにおける分かち書きトークナイズ精度の確認。
3. **リンク連携**: [[Kickoff]] および [[2026-08-17]] との相互リンク解決テスト。

## 留意事項
UTF-8（BOMなし）での保存を徹底し、OS間のファイル名エンコーディング差異（NFC/NFD）に配慮すること。
"@ `
    -TestPurpose "Unicode folder and filename (Japanese)"

Create-VaultFile `
    -RelativePath "Projects/Client Website (Draft) v2.md" `
    -Content @"
---
tags:
  - client-work
  - drafts
  - web-design
created: 2026-08-08
---

# Client Website Redesign (Draft v2)

Second revision of the visual design system and information architecture. Focused on high-density readability, warm paper surfaces, and responsive tactile controls.

## Review Notes
- Hierarchy aligns well with the guidelines established in [[Old Meeting Notes]].
- Image cards now use content-aware preview frames rather than arbitrary cropping.
- Ensure all reference typography tokens match the core brand specifications.
"@ `
    -TestPurpose "Spaces and parentheses in filename"

# 6. Create Areas Notes
Create-VaultFile `
    -RelativePath "Areas/Health & Fitness/Workout Log.md" `
    -Content @"
---
tags:
  - health/fitness
  - training-log
  - habits
created: 2026-08-10
---

# Weekly Training Log

## Monday (2026-08-10)
- Morning Run: 6.2 km, average pace 5:08/km. Heart rate maintained in Zone 2.
- Core: 3 sets of hanging leg raises, ab wheel rollouts, side planks.

## Tuesday (2026-08-11)
- Upper Body Strength: Barbell overhead press (4x6 @ 60kg), weighted pull-ups (4x6 @ +15kg), dips (3x10).

## Wednesday (2026-08-12)
- Zone 2 Stationary Cycling: 45 minutes, average cadence 88 RPM.

## Thursday (2026-08-13)
- Lower Body: Back squats (4x5 @ 115kg), Romanian deadlifts (3x8 @ 90kg), standing calf raises.

## Friday (2026-08-14)
- Recovery & Mobility: 30 minutes focused on thoracic spine and hip mobility.

## Saturday (2026-08-15)
- Trail Run: 11.5 km, elevation gain 210m. Practiced steady breathing on ascents.

## Sunday (2026-08-16)
- Rest Day: Active recovery walk and foam rolling. See mindset reflections in [[😀 Motivation]].
"@ `
    -TestPurpose "Structured workout log across one week"

Create-VaultFile `
    -RelativePath "Areas/Health & Fitness/😀 Motivation.md" `
    -Content @"
---
tags:
  - health/mindset
  - quotes
  - daily-discipline
created: 2026-08-09
---

# Daily Motivation & Principles

> "We are what we repeatedly do. Excellence, then, is not an act, but a habit." — Will Durant

## Core Rules
1. Never miss two consecutive planned sessions in [[Workout Log]].
2. Focus on movement quality and joint longevity over aggressive load progression.
3. Keep recovery, sleep, and nutrition as prioritized as active training.
"@ `
    -TestPurpose "Emoji in filename (😀 Motivation.md)"

# 7. Create Resources Notes
Create-VaultFile `
    -RelativePath "Resources/Reading List.md" `
    -Content @"
---
tags:
  - reading
  - books
  - pkm
created: 2026-08-03
---

# Reading List & Bibliographic Notes

Curated reading material on distributed systems, information architecture, and cognitive ergonomics.

## Active Queue
- **Designing Data-Intensive Applications** by Martin Kleppmann
- **Building a Second Brain** by Tiago Forte
- **The Design of Everyday Things** by Don Norman

![[book-cover.png]]

## Key Insights
- Local-first software must treat the filesystem as the authoritative source of truth.
- Cross-document linking like [[Grandma's Apple Pie]] and [[Kickoff]] enriches semantic graph traversal over time.
"@ `
    -TestPurpose "Markdown note with ![[book-cover.png]] embed"

Create-VaultFile `
    -RelativePath "Resources/Recipes/Grandma's Apple Pie.md" `
    -Content @"
---
tags:
  - recipe/baking
  - family
  - desserts
created: 2026-07-20
---

# Grandma's Traditional Apple Pie

A classic spiced apple pie recipe featuring a flakey all-butter crust and caramelized Honeycrisp apples.

## Ingredients
- 6 medium Honeycrisp or Granny Smith apples, peeled and thinly sliced
- 3/4 cup granulated cane sugar
- 2 tbsp all-purpose flour
- 1 tsp ground cinnamon
- 1/4 tsp ground nutmeg
- 2 homemade all-butter pie crust rounds
- 2 tbsp unsalted butter, cubed into small pats

## Preparation
1. Preheat oven to 400°F (200°C).
2. Toss sliced apples with sugar, flour, cinnamon, and nutmeg in a large mixing bowl.
3. Fit bottom crust into 9-inch pie plate. Fill with seasoned apples and dot with butter cubes.
4. Top with second crust, crimp edges, and cut four 1-inch steam vents.
5. Bake for 45 minutes until the pastry is golden and fruit juices gently bubble.
"@ `
    -TestPurpose "Apostrophe in filename (Grandma's Apple Pie.md)"

Create-VaultFile `
    -RelativePath "Resources/Empty Note.md" `
    -Content "" `
    -TestPurpose "Truly empty file (0 bytes)" `
    -IsEmpty

Create-VaultFile `
    -RelativePath "Resources/Frontmatter Only.md" `
    -Content @"
---
tags:
  - metadata/stub
  - schema-validation
created: 2026-08-14
status: draft
reviewed: false
---
"@ `
    -TestPurpose "YAML frontmatter only (no body text)"

# 8. Create Archive Notes
Create-VaultFile `
    -RelativePath "Archive/2024/Old Meeting Notes.md" `
    -Content @"
---
tags:
  - archive/2024
  - meetings
  - minutes
created: 2024-11-14
---

# Architecture Sync — November 2024

**Date:** November 14, 2024
**Participants:** Alex, Jordan, Taylor, Morgan
**Agenda:** Vault ingestion protocols & storage format selection

## Discussion Summary
1. Evaluated plain Markdown versus binary blob storage for note content. Confirmed that plain Markdown files remain the most durable format for end-user data ownership.
2. Discussed embedding pipeline throughput and chunking strategies.
3. Outlined the Q4 retrospective requirements documented in [[Q4 Review]].

## Action Items
- Alex to complete parser benchmarks.
- Taylor to review schema compatibility with legacy exports.
"@ `
    -TestPurpose "Meeting minutes format from archive"

Create-VaultFile `
    -RelativePath "Archive/2024/Q4 Review.md" `
    -Content @"
---
tags:
  - archive/2024
  - retrospective
  - engineering
created: 2024-12-28
---

# 2024 Q4 Engineering Retrospective

The final quarter of 2024 focused on establishing our core data integrity guarantees and validating local-first synchronization primitives. Moving away from monolithic sync daemons toward lightweight, deterministic file scanners allowed us to achieve sub-second indexing cycles on standard SSD volumes.

Our primary achievement was the stabilization of our hybrid search pipeline. Combining traditional inverted index keyword queries with 768-dimensional dense vector embeddings resulted in a noticeable improvement in search relevance, particularly when handling vague descriptive queries.

From an infrastructure perspective, we established strict network boundary controls and hardened our private IP filters to eliminate server-side request forgery risks during remote URL extraction. This security baseline gave us confidence to support arbitrary user inputs without compromising local network isolation.

Reviewing our historical notes in [[Old Meeting Notes]], the milestones we achieved during this quarter laid the direct foundation for the current architecture outlined in [[Kickoff]]. The design tokens and layout conventions formulated here continue to govern our production visual system.

As we look toward upcoming releases, our top priority remains keeping memory overhead minimal during bulk vault synchronizations, ensuring that client performance never degrades even when managing vaults containing thousands of interconnected notes.
"@ `
    -TestPurpose "Long retrospective note (4-5 paragraphs)"

# 9. Create Attachments & Canvas (Non-Markdown sync skip tests)
Create-VaultFile `
    -RelativePath "Attachments/diagram.png" `
    -Content "not a real png" `
    -TestPurpose "Non-Markdown binary stub (.png -- sync should skip)"

Create-VaultFile `
    -RelativePath "Attachments/spec.pdf" `
    -Content "not a real pdf" `
    -TestPurpose "Non-Markdown binary stub (.pdf -- sync should skip)"

Create-VaultFile `
    -RelativePath "Canvas/Mind Map.canvas" `
    -Content '{"nodes":[],"edges":[]}' `
    -TestPurpose "Obsidian canvas file (.canvas -- sync should skip)"

# 10. Create Templates Note
Create-VaultFile `
    -RelativePath "Templates/Daily Note Template.md" `
    -Content @"
---
tags:
  - template
  - daily-log
created: {{date}}
---

## Priorities for Today
- [ ] Top priority objective
- [ ] Secondary deliverable
- [ ] Team sync or code review

## Working Log
Captured stream-of-consciousness notes, debug observations, and cross-references to [[Tasks]].

## End-of-Day Review
What went well today, what was learned, and what carries over to tomorrow?
"@ `
    -TestPurpose "Template note with {{date}} placeholder"

# 11. Create Root Special Characters Note
Create-VaultFile `
    -RelativePath "Q&A - Draft (v1.1) #urgent.md" `
    -Content @"
---
tags:
  - qa
  - urgent
  - edge-cases
created: 2026-08-16
---

# Vault Ingestion Q&A (Release v1.1)

### Q: How does the parser handle complex filenames with special characters?
**A:** Filenames containing ampersands, octothorpes, dots, and parentheses (like this file) must be resolved literally without breaking filesystem path bindings or markdown URI decoders.

### Q: Are non-markdown assets synced automatically?
**A:** No. Files such as ``.png``, ``.pdf``, and ``.canvas`` are ignored during markdown ingestion passes, as tested in [[Reading List]].

### Q: Where are active sprint tasks tracked?
**A:** Refer to the operational checklist in [[Tasks]].
"@ `
    -TestPurpose "Special characters in name (&, #, dots, parentheses, spaces)"

# 12. Create Massive Note programmatically (~900KB - 950KB)
$massiveFrontmatter = @"
---
tags:
  - research/large-scale
  - benchmarks
  - stress-test
created: 2026-08-15
---

# Comprehensive Knowledge Retrieval & Indexing Benchmarks

"@

$massiveParagraph = "High-throughput vector indexing in personal knowledge management systems requires careful balance between vector quantization, graph exploration overhead, and disk serialization throughput. When processing dense collections of interconnected markdown notes, combining dense 768-dimensional embeddings with sparse lexical tsvector indices ensures high recall accuracy across both exact technical identifiers and vague conceptual memories. The reciprocal rank fusion formula normalizes disparate scoring distributions without requiring expensive global cross-encoders. In local-first desktop environments, memory-mapped storage and asynchronous background workers allow the user interface to remain responsive while indexing multi-megabyte document hierarchies. Evaluating cache eviction strategies, graph branch factors, and cosine similarity thresholds across extensive benchmarks confirms that sub-50 millisecond query latencies are reliably achievable on modern consumer hardware."

$sb = [System.Text.StringBuilder]::new()
$null = $sb.AppendLine($massiveFrontmatter.TrimEnd())
$null = $sb.AppendLine()

while ($sb.Length -lt 920000) {
    $null = $sb.AppendLine($massiveParagraph)
    $null = $sb.AppendLine()
}

Create-VaultFile `
    -RelativePath "Massive Notes/Research Dump.md" `
    -Content $sb.ToString() `
    -TestPurpose "Large note near 1MB limit (~920KB generated programmatically)"

# 13. Output Summary Table
Write-Host ""
Write-Host ("=" * 115) -ForegroundColor Cyan
Write-Host ("  OBSIDIAN TEST VAULT FIXTURE GENERATED AT: {0}" -f (Resolve-Path $VaultRoot).Path) -ForegroundColor Cyan
Write-Host ("=" * 115) -ForegroundColor Cyan
Write-Host ("{0,-48} {1,14}  {2}" -f "Relative Path", "Size (Bytes)", "Test Purpose") -ForegroundColor Yellow
Write-Host ("{0,-48} {1,14}  {2}" -f ("-" * 48), ("-" * 14), ("-" * 50)) -ForegroundColor DarkGray

foreach ($row in $summary) {
    $color = if ($row.Bytes -eq 0) {
        "DarkYellow"
    } elseif ($row.Bytes -gt 500000) {
        "Magenta"
    } elseif ($row.RelativePath -like ".*") {
        "DarkGray"
    } else {
        "White"
    }

    Write-Host ("{0,-48} {1,14:N0}  {2}" -f $row.RelativePath, $row.Bytes, $row.TestPurpose) -ForegroundColor $color
}

Write-Host ("=" * 115) -ForegroundColor Cyan
Write-Host ("Total Files Created: {0}" -f $summary.Count) -ForegroundColor Green
Write-Host ""
