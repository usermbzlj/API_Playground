# TRUNCATION_SENTINEL v0.1

截断不能靠「前面还能解析」蒙混过关。闭集是三态：`PASS`、`FAIL`、`TRUNCATED`。`TRUNCATED` 既不是 `PASS`，也不是 `FAIL`。

运行：`python3 truncation_sentinel_v0_1.py`（自测全过才是 exit 0）。样本由脚本按固定规则生成，不访问网络。`expected.json` 顶层有 `spec_version` 与 `criteria_digest`，`cases` 里每个 `case_id` 对应 `{expected_verdict, reason_code}`。

`criteria_digest` 是下方准则区原文的 sha256（`README.md` 磁盘字节，不做尾随换行裁剪）：标记行 `<!-- BEGIN CRITERIA -->` 的换行之后，到标记行 `<!-- END CRITERIA -->` 之前。

```bash
python3 -c "import hashlib,pathlib; b=pathlib.Path('README.md').read_bytes(); s=b.split(b'<!-- BEGIN CRITERIA -->\n',1)[1].split(b'<!-- END CRITERIA -->',1)[0]; print(hashlib.sha256(s).hexdigest())"
```

`run_out_sha256` 是 `run_out_v0_1.json` 磁盘原始字节的 sha256（含末尾 LF）。产物里不写这条回执。

## 不变量 / Invariants

- 正文是记录行拼起来的 UTF-8 字节。记录行以 LF（`0x0A`）结尾，且整行不是哨兵。
- 哨兵行只认最后一片的最后一行：`#sha8:` 加 sha256(正文) 的前 8 位小写十六进制，再加 LF。哨兵不计入正文，也不计入记录条数。
- 三条比较任何一条失败，判词都是 `TRUNCATED`，不能改判成 `PASS` 或 `FAIL`。
- 哨兵出现在最后一片以外（含第一片已经写了哨兵、后面的片是 `null`）时，判词是 `TRUNCATED`，reason_code 为 `SENTINEL_IN_FIRST_SHARD`，不得为 `PASS`。哪怕第一片哨兵对得上第一片正文的 sha8，也一样。
- `json.loads` 成功不参与判定。前缀仍能解析的截断 JSON 不得因此判 `PASS`。
- 朴素基线：收到非空字节就判 `PASS`；字节能被 `json.loads` 解析也判 `PASS`。它从不返回 `TRUNCATED`。

## 规则 / Rules

| 顺序 | 条件 | expected_verdict | reason_code |
| --- | --- | --- | --- |
| 0 | `declared_bytes` 或 `declared_records` 不是整数 | FAIL | DECLARATION_ABSENT |
| 1 | 哨兵不在最后一片（第一片有哨兵，且后段缺失） | TRUNCATED | SENTINEL_IN_FIRST_SHARD |
| 2 | 流不以 LF 结尾 | TRUNCATED | CUT_MID_LINE |
| 3 | 没有任何哨兵行 | TRUNCATED | CUT_BEFORE_SENTINEL |
| 4 | 声明的字节数或记录数与正文不符 | TRUNCATED | COUNT_MISMATCH |
| 5 | 末行 sha8 与 sha256(正文) 的前 8 位不符 | TRUNCATED | SHA_MISMATCH |
| 6 | 三条比较都成功，且哨兵在最后一片的最后一行 | PASS | COMPLETE |

正控：单片写全；正文拆成两片，哨兵只在最后一片。

Must-fail（朴素基线得到 `PASS`，诚实判定不是 `PASS`）：`cut-before-sentinel`、`sha-mismatch`、`cut-mid-line`、`sentinel-in-first-shard`，外加「截断 JSON 的前缀仍能解析」。

<!-- BEGIN CRITERIA -->
规格 spec_version: v0.1
夹具 fixture: truncation_sentinel
闭集 closed_verdicts: PASS | FAIL | TRUNCATED
TRUNCATED 既不是 PASS，也不是 FAIL。三条比较任一失败都只产生 TRUNCATED。
判定只读 shards、declared_bytes、declared_records。不读 expected_verdict，不读 reason_code，不读 must_fail。
shards：数组。元素是字符串或 null。null 表示这一片没有收到。最后一片指数组的最后一个元素，即使它是 null。收到的流是按顺序拼接所有字符串元素的 UTF-8 字节。
记录行：以 LF（字节 0x0A）结尾的完整行，且整行不是哨兵行。
哨兵行：恰好是 #sha8: 加 8 位小写十六进制再加 LF。哨兵行不计入正文，也不计入记录条数。
正文 body：按顺序拼接全部记录行。不含哨兵行，不含末尾没有 LF 的半行。
sha8：sha256(body) 十六进制摘要的前 8 位，小写。
比较 (1)：declared_bytes 与 declared_records 都是整数（布尔不算），且 declared_bytes == 正文的字节数，declared_records == 记录行条数。
比较 (2)：收到的流非空，且最后一个字节是 LF。
比较 (3)：收到的流的最后一行是哨兵行，且其中 8 位十六进制等于 sha8。
按下面顺序，命中即停。
0. declared_bytes 不是整数，或 declared_records 不是整数 -> FAIL DECLARATION_ABSENT。
1. 某一片的下标不是最后一片，且该片含有哨兵行 -> TRUNCATED SENTINEL_IN_FIRST_SHARD。第一片有哨兵而后面的片为 null 时命中本条，不得 PASS。
2. 比较 (2) 失败 -> TRUNCATED CUT_MID_LINE。
3. 收到的流中没有哨兵行 -> TRUNCATED CUT_BEFORE_SENTINEL。
4. 比较 (1) 失败 -> TRUNCATED COUNT_MISMATCH。
5. 比较 (3) 失败 -> TRUNCATED SHA_MISMATCH。
6. 三条比较都成功，且哨兵行是最后一片的最后一行 -> PASS COMPLETE。
json.loads 成功不参与判定。前缀仍能解析不得因此判 PASS。
<!-- END CRITERIA -->

## TODO real-machine samples（真虾）

真虾稍后会补两份真机样本。下面两个槽位现在是空的，不参与 v0.1 自测，也不算已经通过：

- [ ] cut-before-sentinel：TODO 真机样本（尚未提供）
- [ ] sha-mismatch：TODO 真机样本（尚未提供）

合成样本已经覆盖这两条臂。真机字节到来之前不要往槽位里填伪造的「实机」数据。准则区在标记之内，补样本时改本段不会改 `criteria_digest`。

Credits: truncation_sentinel 与 EigenFlux agent 真虾共同设计；真虾稍后贡献 cut-before-sentinel 与 sha-mismatch 的真机样本。
