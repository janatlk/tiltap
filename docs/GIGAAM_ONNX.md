# GigaAM Multilingual large_ctc в ONNX: экспорт и замеры

> Замеры 2026-07-24 на `tiltab-cx43-hel2` (8 vCPU AMD EPYC Rome, 15 ГБ RAM),
> 90 с киргизского аудио (`ky_test.wav`), нарезка на куски по 24 с.

## Короткий вывод

**На этом сервере ONNX не ускоряет GigaAM.** torch остаётся самым быстрым
движком. Экспорт сделан и подключён к бета-странице, но как основа для
GPU-варианта и для сравнения качества, а не как ускорение CPU.

## Готовой ONNX-сборки нашей модели не существует

Всё, что находится в поиске, — конверсии **другой** модели:
[istupakov/gigaam-v3-onnx](https://huggingface.co/istupakov/gigaam-v3-onnx) и
`gigaam-v2-onnx` собраны из `ai-sage/GigaAM-v3` / `v2`, это **русскоязычные**
модели. Подмена ими `multilingual_large_ctc` оставит рабочим русский и тихо
сломает ky/uz. В [ai-sage/GigaAM-Multilingual](https://huggingface.co/ai-sage/GigaAM-Multilingual)
ONNX-файлов нет.

Поэтому экспортируем сами.

## Как воспроизвести

Пакет `gigaam` с PyPI (0.1.0) знает только v2 — мультиязычных имён там нет.
Нужны исходники с GitHub, разложенные в `/opt/tiltap/vendor/gigaam-src`
(`pip install git+...` ставит битый пакет `UNKNOWN-0.0.0`, не помогает):

```bash
git clone --depth 1 https://github.com/salute-developers/GigaAM /opt/tiltap/vendor/gigaam-src
```

Экспорт — `fp16_encoder=False` обязателен, fp16 это GPU-оптимизация и на CPU
только портит результат:

```python
import sys; sys.path.insert(0, "/opt/tiltap/vendor/gigaam-src")
import gigaam
m = gigaam.load_model("multilingual_large_ctc", fp16_encoder=False, device="cpu",
                      download_root="/opt/tiltap/models/gigaam_ckpt")
m.to_onnx(dir_path="/opt/tiltap/models/onnx")
```

Веса (2.2 ГБ) тянутся с CDN Сбера, не с HuggingFace. Граф сохраняется в формате
external data: `multilingual_large_ctc.onnx` — всего 2.7 МБ, веса лежат
отдельными файлами рядом. Каталог нельзя разделять.

Квантизация:

```python
quantize_dynamic(src, dst, weight_type=QuantType.QInt8, reduce_range=True,
                 op_types_to_quantize=["MatMul"], use_external_data_format=True,
                 extra_options={"MatMulConstBOnly": True})
```

`reduce_range=True` — потому что Zen 2 умеет AVX2, но не VNNI, и полный диапазон
int8 при накоплении насыщается. Только `MatMul`: квантовать depthwise-свёртки
Conformer'а — терять качество почти без выигрыша в скорости.

**Квантизации нужно ~10 ГБ RAM**, а на машине столько свободно не бывает —
процесс убивает OOM. Лечится временным swap-файлом (`fallocate -l 10G`), сервис
останавливать не требуется. Сама квантизация занимает 22 секунды.

## Замеры

| движок | лучшее из 2 | RTF | peak RSS | на диске |
|---|---|---|---|---|
| **torch fp32** | **9.8 с** | **0.11** | 3.11 ГБ | 2.2 ГБ |
| ONNX int8 | 10.6 с | 0.117 | — | **797 МБ** |
| ONNX fp32 | 11.4 с | 0.127 | — | 2.2 ГБ |

Матрица настроек ORT (все с `allow_spinning=0`):

| | batch=1 | batch=8 |
|---|---|---|
| fp32, 8 потоков | 11.4 с | 12.1 с |
| fp32, 4 потока | 12.6 с | 12.6 с |
| int8, 8 потоков | 10.8 с | 10.6 с |
| int8, 4 потока | 11.9 с | 12.0 с |

## Почему ONNX здесь проигрывает

- У Conformer **относительное позиционное внимание**, под которое у ORT нет
  правила фьюзинга. В ONNX оно разворачивается в россыпь MatMul/Softmax/Transpose,
  тогда как torch 2.12 вызывает SDPA с эффективными CPU-ядрами.
- Питоновский оверхед, который обычно и убирает ONNX, тут почти отсутствует:
  90 с аудио — это 4 вызова модели, а не тысячи.
- int8 даёт лишь ~7% над fp32-ONNX: **нет VNNI**. Цифры вида «int8 в 3 раза
  быстрее» относятся к Xeon с VNNI/AMX и к этой машине неприменимы.

Проверено и отвергнуто как причина: переподписка потоков (8 потоков быстрее 4),
busy-spin ORT (отключение не помогло), размер батча (влияет слабо).

> Первые замеры показывали torch на уровне ~1x realtime и ONNX «в 7 раз быстрее».
> Это был артефакт: воркер сериализует запросы через `_lock`, и параллельный
> запрос ставил замер в очередь. Мерить только при `loadavg < 1`.

## Что с этим делать

- **CPU:** оставить torch. ONNX-варианты живут на бета-странице для сравнения
  качества (int8 просаживает языки неравномерно — ky/uz первыми, проверять
  по каждому отдельно, а не по среднему).
- **GPU RunPod:** вот там экспорт и пригодится — нужен отдельный
  `to_onnx(dtype=torch.float16)`, на GPU fp16 действительно быстрее и экономит
  VRAM. Текущий fp32-экспорт этому не мешает и не является тупиком.
- Ускорение CPU, если понадобится, искать не в формате, а в VAD (не гонять
  энкодер по тишине) — `vad_utils.py` в проекте есть, но на CPU-пути не задействован.

## Пути на сервере

| что | где |
|---|---|
| исходники gigaam | `/opt/tiltap/vendor/gigaam-src` |
| чекпоинт | `/opt/tiltap/models/gigaam_ckpt/multilingual_large_ctc.ckpt` |
| ONNX fp32 | `/opt/tiltap/models/onnx/` |
| ONNX int8 | `/opt/tiltap/models/onnx_int8/` |

Переопределяются через `TILTAB_GIGAAM_ONNX_SRC`, `TILTAB_GIGAAM_ONNX_FP32`,
`TILTAB_GIGAAM_ONNX_INT8`, `TILTAB_GIGAAM_ONNX_BATCH`.
