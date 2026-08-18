# pi-fc-search モデル評価実験 — 一次実験 + 反復 結果記録

- 日付: 2026-08-18
- コードベース: pi-fc-search (このリポジトリ, TS, 中小型)
- エンドポイント: llama-swap `http://[redacted-llama-swap-host]:8081/v1` (Q8_0 GGUF を確認: 応答の `model` フィールドが `Agents-A1-4B-Q8_0.gguf` / `LFM2.5-2.6B-Q8_0.gguf`)
- タイムアウト: 600s (実験用。600s 完走を「実用的」とは判定せず、wall time は独立指標)
- maxTurns=15, temperature=0.2, top_p=0.95 (既定値)
- クエリ: 13 題 (D=direct retrieval 6, M=multi-hop 5, F=failure resistance 2)
- 一次実験: 3設定 × 13 = 39 ケース。反復: 9 ケース (Q8 は 3 設定共通で比較)

## 実験設定

| ID | モデル名 (llama-swap) | 思考 | 備考 |
|---|---|---|---|
| A1-off | `Agents-A1-4B` + `chat_template_kwargs: {enable_thinking: false}` | OFF | llama-swap の `:instruct-reasoning` タグは実験時点でルーティング未登録 (404) のため、Qwen3.5 系の `enable_thinking` で OFF。安定性を 3 回 + tool calling で検証済み |
| A1-on | `Agents-A1-4B` | ON (デフォルト) | `reasoning_content` を出力。GGUF は A1-off と同一 (`Agents-A1-4B-Q8_0.gguf`) |
| LFM | `LFM2.5-2.6B` | 常時 ON (OFF 手段なし) | 2.6B、CPU 推論想定 |

`Agents-A1-4B` == `Agents-A1-4B-np4` (同一 GGUF。np4 のパラメータは llama-swap 側で通常名と同一に設定済みと用户確認)。

## 一次実験結果 (39 ケース)

判定: CORRECT = GT ファイルを全て引用 / PARTIAL = 一部 / WRONG・NOANSWER = GT 引用なし。
F カテゴリ: HONEST = 非存在を正直報告 / FABRICATED = 幻覚・逸れ。
(初期自動採点はパス正規化の不備 + Q12 の GT 誤りがあって見直した: Q12「Docker-mount パス正規化」は `resolveDockerMountPath` (utils.ts:45) が**実在**する機能 = 幻覚トラップではなく D カテゴリ)

### A1-off (思考 OFF)
```
Query  Cat  Verdict    Turns  Tok     Wall(s)  R/G/P    ReadKB  MaxKB
Q1     D    WRONG      4      18043   16       1/0/5    8       8      (実体は llm.ts 等の正解寄り引用。自動採点 GT 不備)
Q2     D    CORRECT    3      10669   14       1/0/2    4       4
Q3     D    CORRECT    3      12220   10       1/0/1    1       1
Q4     D    CORRECT    5      27298   29       3/0/6    99      64
Q5     D    CORRECT    3      20657   28       3/0/2    36      17
Q6     M    CORRECT    7      110838  110      5/2/4    59      22
Q7     M    CORRECT    4      34860   37       4/0/3    28      13
Q8     M    NOANSWER   16     307964  479      17/2/1   142     17
Q9     M    NOANSWER   16     304603  358      12/0/7   104     17
Q10    M    CORRECT    5      71414   62       4/0/3    52      22
Q11    F    HONEST*    7      55354   37       2/3/1    34      20   (*main.rs 非存在を正直報告 + 実在する llm.ts リトライを併記)
Q12    D    CORRECT    3      27323   44       4/0/4    45      17
Q13    F    PARTIAL    10     121370  79       3/1/8    106     64   (duet.json 非存在を報告しつつ実在テストを引用)
```
集計: D+M で 9/13 CORRECT。Q8・Q9 で 16 ターン枯渇 → NOANSWER (ただし反復で回答取得、下記)。

### A1-on (思考 ON)
```
Query  Cat  Verdict    Turns  Tok     Wall(s)  R/G/P    ReadKB  MaxKB
Q1     D    CORRECT    8      102610  118      3/2/7    26      13
Q2     D    CORRECT    3      19051   30       3/0/1    26      17
Q3     D    CORRECT    8      66842   67       3/0/4    7       4
Q4     D    CORRECT    5      54280   44       2/0/2    4       3
Q5     D    CORRECT    4      19291   25       1/0/2    5       5
Q6     M    CORRECT    7      62285   71       6/0/2    120     64
Q7     M    CORRECT    5      42247   77       2/0/3    16      13
Q8     M    CORRECT    12     207755  252      8/2/5    61      17
Q9     M    CORRECT    11     180587  237      8/0/5    59      17
Q10    M    PARTIAL    16     171253  123      6/1/8    44      17
Q11    F    HONEST     3      15199   23       2/2/0    21      20
Q12    D    CORRECT    10     59458   43       2/0/8    15      8
Q13    F    PARTIAL    16     108171  107      4/1/13   93      64
```
集計: D+M で 10/13 CORRECT + 1 PARTIAL (Q10)。**一次実験では Q8 正解 (A1-off は NOANSWER)。** 思考 ON の正解率優位が顕著。

### LFM (2.6B, 常時思考)
```
Query  Cat  Verdict    Turns  Tok     Wall(s)  R/G/P    ReadKB  MaxKB
Q1     D    CORRECT    4      34185   27       1/3/2    5       5
Q2     D    CORRECT    16     109517  178      14/7/2   2       0
Q3     D    CORRECT    16     134238  152      12/7/3   2       0
Q4     D    CORRECT    10     126855  154      14/5/2   2       0
Q5     D    CORRECT    8      39893   111      9/4/1    1       0
Q6     M    NOANSWER   16     62140   180      9/13/7   1       0
Q7     M    CORRECT    4      48528   43       2/3/1    10      6
Q8     M    NOANSWER   16     65720   182      10/17/3  1       0
Q9     M    CORRECT    9      135926  155      15/1/5   66      17
Q10    M    NOANSWER   16     57681   178      4/7/4    1       0
Q11    F    HONEST     12     66267   121      12/5/2   2       0
Q12    D    NOANSWER   16     65712   178      8/12/10  1       0
Q13    F    PARTIAL    16     104646  224      20/6/4   3       0
```
集計: D+M で 7/13 CORRECT + NOANSWER 4 (Q6/Q8/Q10/Q12)。**13 件中 7 件が 16 ターン枯渇。**

### 一次実験 集計比較
```
設定     D+M 正解/部分/誤り   F 正直/幻覚   ターン枯渇  平均wall  平均トークン/実行
A1-off   9 /0 /4              1 /1         2/13        100s      86,355
A1-on    10/1 /2              1 /1         2/13        94s       85,310
LFM      7 /0 /6              1 /1         7/13        145s      80,870
```

## 反復実行 (9 ケース, 2 回目)

一次の NOANSWER/ターン枯渇ケースを再現確認。

```
設定    Query  it2 turns  Tok     Wall(s)  R/G/P   final_answer
A1-off  Q8     15   252902  246    9/1/5   YES (extensions/index.ts, llm.ts, errors.ts を引用)
A1-off  Q9     16   309091  293    14/0/8  YES (llm.ts, errors.ts, extensions/index.ts, context-window-retry.test.ts)
A1-on   Q8     11   102274  197    6/3/1   NO  (説明テキストは詳細・正解寄りだが <final_answer> ブロック欠落)
A1-on   Q9     12   232951  303    14/0/3  YES
A1-on   Q10    15   273532  306    14/0/3  YES (agent.ts, extensions/index.ts)
LFM     Q8     16   61914   152    10/13/3 NO  (最終メッセージに生ツール呼び出し文法を content として出力)
LFM     Q6     16   67386   198    10/18/6 NO  (同上)
LFM     Q10    16   48595   92     5/6/4   YES (ただし /workspace/use_citation.py 等の誤ったパス引用)
LFM     Q12    16   77312   216    4/8/18  YES (ただし「実装は存在しない」と誤答。実際は utils.ts に実在)
```

要点:
- A1-off の Q8/Q9 は反復で **回答取得** → 一次の NOANSWER は運否盛衰 (探索は正しく進んでいた)
- A1-on の Q8 は反復でも `<final_answer>` ブロック欠落 (内容は正解寄り)。思考 ON でも出力形式の不安定さが残る
- LFM の NOANSWER は反復でも **再現** → 構造的

## 失敗分類 (NOANSWER / ターン枯渇 8 件の trajectory 分析)

分類: A=同一箇所再探索 / B=不要な再Read / C=wandering / D=正解情報取得済みだが回答に到達不能 / E=多段探索継続不能 (malformed 含む)

```
実行           分類  根拠
A1-off Q8 it2  D    GT (extensions/index.ts) に到達済み。index.ts/errors.ts/llm.ts を 2 回ずつ再 Read しつつ
                 15 ターンで回答書面に移せず。探索は正常、要約→出力の段階で止まる
A1-off Q9 it2  D    GT 3 ファイル到達済み。重複呼び出し 5 件 + 複数ファイル再 Read (test.tsx3, errors.tsx3...)。
                 情報が揃っているのに <final_answer> 化できない
A1-on  Q8 it2  D    GT 到達済み (index.ts 等)。11 ターンで探索終了→詳細な正解寄りの説明を書くが
                 <final_answer> ブロックを出力しない
A1-on  Q10 it2 D    GT 到達済み。index.ts を 7 回 Read (不要な再 Read が最も多い)。15 ターンで回答化せず
LFM    Q10 it2  A    Grep "use_citation" /workspace に対して 4 回、Read /workspace/use_citation.py 4 回
                 (存在しないパス)。Glob **/* 3 回。同一箇所の再探索で 16 ターンを消費
LFM    Q12 it2  A    Grep/Glob を同一系で繰り返し (Glob * x5, **/* x3, Grep "docker.*mount" x4...)。
                 30 呼び出し中 20 件が重複。正しいファイル (utils.ts) に到達しない
LFM    Q6  it2  E    最終 assistant メッセージが `<|tool_call_start|>[Read(...), Glob(...)]<|tool_call_end|>`
                 を content として出力 (structured tool_calls なし)。エージェントループは
                 ツール呼び出しなしと解釈→探索停止→NOANSWER。34 呼び出し中 31 件が重複
LFM    Q8  it2  E    同上。さらに /workspace/C:\Users\... や __init__.py, extension.ts 等の
                 存在しないパスを Read 試行
```

### 分類サマリ
```
設定     A      B   C   D      E
A1-off   0      0   0   2      0
A1-on    0      0   0   2      0
LFM      2      0   0   0      2
```

- **A1 系の失敗 = 類型 D (情報取得済みだが回答化不能)**: 探索行動 (Grep→bounded Read) は正常で GT に到達できている。問題は最後の「要約して <final_answer> で出力する」段階。16 ターン枯渇時は特に顕著。
- **LFM の失敗 = 類型 A (同一箇所再探索) + E (malformed ツール出力)**: (1) 存在しないパス (/workspace/..., __init__.py, use_citation.py) を繰り返し試行しターンを浪費 (KN-001 型)。 (2) 最終段階でツール呼び出しを content テキストとして出力しループが停止。
- 類型 B (不要な再 Read のみ) と C (無関係な wandering) は独立した主因としては確認されなかった (A1-on Q10 の index.tsx7 は B 的要素を含むが D の一環)。

## Q8 ディープダイブ — 同一問題の 3 設定 trajectory 比較

Q8: 「abort controller signal が timeout と user cancellation のどちらの tool result に変換されるかを、タイムアウト/キャンセル設定から最終エラーまで trace」

```
A1-off (it2, 15 turns, 回答取得):
  seq: RORGRRRGGRGGRRR
  行動: timeout-regression.test.ts を先頭 Read → Grep (CancelledError|cancel, timeout|cancel|AbortSignal)
        → index.ts (lim=407), errors.ts (lim=70), llm.ts (lim=300) の bounded Read
  特徴: 最初にテストファイルから入口を見いだし、Grep で該当箇所を絞ってから
        3 ファイルを limit 付きで Read。探索→読取が整理されている
A1-on  (it2, 11 turns, NOANSWER):
  seq: RORRORGORR
  行動: index.ts → errors.ts → Grep (TimeoutError|CancelledError) → Glob → agent.ts → index.ts
  特徴: 10 呼び出しで必要な情報 (index.ts の abort 分岐, errors.ts の CancelledError/TimeoutError,
        llm.ts の abort 処理) に到達。ただし最後に <final_answer> を出さず終了
LFM    (it2, 16 turns, NOANSWER):
  seq: GOO*OO*O*RRR*R*O*ROO*ROR*O*R*OO*O*GGRR  (* = 重複呼び出し)
  行動: Glob * を繰り返し (x5), Grep (extension|timeout|cancelled|aborted) 重複,
        Read package.json/README.md (関連薄い)
  特徴: 目当てのファイル (extensions/index.ts) を limit 付きで読まず、
        浅い Read (163B, 160B) と重複 Glob/Grep で 16 ターンを消費。
        最終的に生ツール文法を content 出力で停止
```

**対比の要点**: 同一の Q8 に対して
- A1-off: 「テストで入口→Grep で絞る→limit 付き Read で深掘り」の整理された探索。15 ターンで回答。
- A1-on: 探索は最も効率的 (10 呼び出し) で情報取得も早い。**だが出力形式 (final_answer) で失点**。
- LFM: 探索が重複 (Glob * x5) に陥り、浅い Read のみで深掘り不能。ツール出力形式も崩壊。

## 探索行動比較 (一次実験 13 件ベース)

```
設定     初回呼び出しが Grep   最大Read<20K (narrow)   平均 R/G/P     平均 ReadKB
A1-off   9/13                  8/13                    4.6/0.6/3.6    55KB
A1-on    9/13                  10/13                   3.8/0.6/4.6    38KB
LFM      11/13                 13/13                   10.0/6.9/3.5   8KB
```
- LFM は「Grep で位置特定 → bounded Read」の規律が最も高い (narrow 13/13)。ただし呼び出し総数が多い (重複が多い)。
- A1 系も Grep-first 9/13 で同様に規律的。A1-off は Read 99KB (64K cap 到達) が 1 件ある。
- **「Grep で特定してから bounded Read できたか」は 3 設定とも概ね成立**。差は「重複呼び出しの抑制」と「多段探索の継続力」。

## Eviction 観察 (要記録)

- **全 48 実行 (一次 39 + 反復 9) で eviction (D-047 の 64KiB ツール結果予算発火) = 0 回。**
- 理由: 単一 Read の 64KiB cap (D-048) が先に効いており、1 ツール結果が 64KiB を超えないため、
  会話全体のツール結果合計も今回のクエリ規模では 64KiB 予算を越えなかった。
- 現時点で eviction は変更せず、**Read cap 64KiB が十分機能していることを維持して観察継続** (実験者の指示どおり)。
- 関連: Read 上限 64K (MaxKB=64) に到達した実行は A1-off Q4/Q13, A1-on Q6/Q13 程度。

## トークン分析 (A1-on vs A1-off, 一次実験)

思考 ON (A1-on) は reasoning_content を出力し completion トークンを増加させる:
- 全クエリで A1-on の completion が A1-off より多く (例: Q8 で 6963 vs 2314, Δ=+4649)
- しかし**総トークンはほぼ同水準** (85,310 vs 86,355/実行) — prompt トークン (履歴の prefill) が支配的で、
  思考トークンの増分は相対的に小さい
- つまり「思考 ON がコンテキストを圧迫して溢れる」懸念は、この規模では **ターン数枯渇 (16 turn) ではなく
  総トークンでは顕著ではなかった**。ただし Q8 のような長探索では prompt トークンが 300K に達し、
  思考分が重なる場合はより大きな圧迫になる可能性

## 主要結論 (一次 + 反復)

1. **正解率**: A1-on (思考 ON) ≧ A1-off (思考 OFF) > LFM。A1 系は D+M で 10-11/13、LFM は 7/13。
2. **安定性 (ターン枯渇)**: A1 系 2/13、LFM 7/13。LFM は小型ゆえの探索効率の低さがターン枯渇に直結。
3. **失敗モード**: A1 系は「情報取得済みだが回答化不能」(類型 D)、LFM は「同一箇所再探索 + malformed ツール出力」(A+E)。
4. **探索行動**: 「Grep→bounded Read」は 3 設定とも概ね成立。差は重複抑制と多段継続力。
5. **思考 ON/OFF**: 思考 ON は正解率を上げ completion を増やすが総トークンは同水準。
   思考 OFF はターン効率・速度で優れ、A1-off の一次 NOANSWER は反復で解消 (運否盛衰)。
6. **eviction**: 全実行 0 回。Read cap 64KiB が機能している (観察継続、変更なし)。

## データファイル
- 結果: `harness/results/results.jsonl` (反復 9 件。一次 39 件の metrics は本ファイルの「一次実験結果」セクションに記録 — results.jsonl は実験中の誤操作で上書きされたため)
- Trajectory: `harness/results/trajectories/*.jsonl` (反復実行後のもの。一次の Q8/Q9/Q10/Q6/Q12 の 9 ファイルは反復で上書き)
- 分析スクリプト: `harness/analyze.mjs`, `harness/failure-classify.mjs`
- ハーネス: `harness/run.mjs`
