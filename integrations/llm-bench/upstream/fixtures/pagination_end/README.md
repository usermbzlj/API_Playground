# PAGINATION_END v0.1

分页读取有没有真正读到头。闭集只有 `GREEN` 和 `RED`。`expected_verdict` 单独成列，不参与判定。

运行：`python3 pagination_end_v0_1.py`（自测全过才是 exit 0）。样本在 `expected.json`：顶层有 `spec_version` 与 `criteria_digest`，`cases` 里每个 `case_id` 对应 `{expected_verdict, reason_code}`。`criteria_digest` 是下方准则区原文的 sha256，不是 JSON 再序列化一次的摘要。

取摘要的字节（不做尾随换行裁剪）：`README.md` 里标记行 `<!-- BEGIN CRITERIA -->` 的换行之后，到标记行 `<!-- END CRITERIA -->` 之前。

```bash
python3 -c "import hashlib,pathlib; b=pathlib.Path('README.md').read_bytes(); s=b.split(b'<!-- BEGIN CRITERIA -->\n',1)[1].split(b'<!-- END CRITERIA -->',1)[0]; print(hashlib.sha256(s).hexdigest())"
```

`run_out_sha256` 是 `run_out_v0_1.json` 磁盘原始字节的 sha256（含末尾 LF）。产物里不写这条回执。

## 不变量 / Invariants

- 判定只看 `page` 与 `probe` 上的字段：`items`（本页条数，整数）、`page_size`（页容量，整数）、`has_more`、`next_cursor`。布尔值不算整数。
- 非空游标只指长度大于 0 的字符串。`null` 不是非空，空串 `""` 也不是非空。空串单独成规则。
- 满页指 `items == page_size`（`page_size > 0`）。满页只有在随后的探测是「一致空页」时才可能 `GREEN`。
- 一致空页：`probe.items == 0`，`probe.has_more` 为 false，且 `probe` 含有键 `next_cursor`、值为 `null`。
- 命中即停，顺序写在准则区里。空串先于「has_more=false 且游标非空」；`next_cursor` 缺键先于一切游标比较。
- 没有命中任何一条时不得判 `GREEN`。
- 朴素基线：`has_more` 为 false，或 `next_cursor` 缺失 / `null` / `""`，就判 `GREEN`。它不看矛盾，也不要求空页探测。每条红规则至少有一条样本让这条基线得到 `GREEN`，诚实判定为 `RED`（must-fail）。

## 规则 / Rules

| 顺序 | 条件 | expected_verdict | reason_code |
| --- | --- | --- | --- |
| 1 | 没有键 `next_cursor` | RED | CONTRACT_FIELD_MISSING |
| 2 | `next_cursor == ""` | RED | EMPTY_STRING_CURSOR |
| 3 | `has_more=true` 且 `next_cursor` 为 null | RED | HAS_MORE_TRUE_WITH_NULL_CURSOR |
| 4 | `has_more=false` 且 `next_cursor` 为非空字符串 | RED | PAGINATION_END_CONTRADICTION |
| 5 | 满页，且 `probe` 不是一致空页 | RED | FULL_PAGE_NOT_PROBED |
| 6 | `has_more=false` 且 `next_cursor` 为 null，并且（未满页，或 `probe` 是一致空页） | GREEN | END_CONFIRMED |

正控至少两条：未满的末页；满页配上一致空页。空页本身（0 条，`has_more=false`，游标 null）也是 `GREEN`。

<!-- BEGIN CRITERIA -->
规格 spec_version: v0.1
夹具 fixture: pagination_end
闭集 closed_verdicts: GREEN | RED
GREEN 的 reason_code 固定为 END_CONFIRMED。
判定只读 page 与 probe，不读 expected_verdict，不读 reason_code，不读 must_fail。
page.items：本页条数，整数。布尔值不算整数。
page.page_size：页容量，整数。布尔值不算整数。
page.has_more：布尔，或字段缺失。
page.next_cursor：字段缺失，或 JSON null，或字符串。
probe：null，或下一页探测，字段与 page 相同。
非空游标：字符串且长度大于 0。null 不是非空。空串 "" 不是非空。
满页：page.items 与 page.page_size 都是整数，page.page_size > 0，且 page.items == page.page_size。
一致空页：probe 是对象，probe.items == 0，probe.has_more 为 false，且 probe 含有键 next_cursor、其值为 null。
按下面顺序，命中即停。
1. page 没有键 next_cursor -> RED CONTRACT_FIELD_MISSING。
2. page.next_cursor 等于空串 "" -> RED EMPTY_STRING_CURSOR。本条单独列出，不并入第 4 条。
3. page.has_more 为 true 且 page.next_cursor 为 null -> RED HAS_MORE_TRUE_WITH_NULL_CURSOR。
4. page.has_more 为 false 且 page.next_cursor 为非空字符串 -> RED PAGINATION_END_CONTRADICTION。
5. 满页，且 probe 不是一致空页 -> RED FULL_PAGE_NOT_PROBED。has_more 为 true 也不能把满页判成 GREEN。
6. page.has_more 为 false，page.next_cursor 为 null，且（page.items 与 page.page_size 都是整数且 page.items < page.page_size，或 probe 是一致空页）-> GREEN END_CONFIRMED。
没有命中任何一条 -> RED UNCLASSIFIED。不得判 GREEN。
<!-- END CRITERIA -->

Credits: pagination_end 规则与 EigenFlux agent 洋洋的workbuddy 共同设计，对方会独立复算本准则区与各 case 判词。
