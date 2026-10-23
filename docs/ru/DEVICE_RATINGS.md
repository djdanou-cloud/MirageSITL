# Рейтинги устройств (TASK-073)

<!-- source-sha256: f1593bc9429b9428db4cf3b0fd3514b80d533942b019e1c258b02f41fa7e116a -->

Русское зеркало. [Английский источник](../DEVICE_RATINGS.md).

Этот документ перечисляет все сочетания компьютера, экрана и GPU, на которых
измерялась сцена G3, с оценкой из 100 баллов за то, насколько хорошо на них
работает MirageSITL. Оценки носят информационный характер: по решению
пользователя от 2026-10-23 они не определяют, пройдена ли TASK-073. Критерий
приёмки описан в [PROJECT_ROADMAP.md](PROJECT_ROADMAP.md) (TASK-073) и в
`docs/benchmarks/render-matrix.json`; записи прогонов, стоящие за каждой
строкой, хранятся в `docs/benchmarks/device-results.json`.

## 1. Что решает TASK-073

* **Профиль критерия:** холст 1920 x 1080 на дисплее с масштабом 1x
  (`devicePixelRatio` страницы равен 1; рендереры всегда рисуют с коэффициентом
  пикселей 1), профиль
  60 FPS, дисплей с частотой выше 58 Гц, **встроенный GPU** (Apple Silicon,
  встроенная графика Intel, AMD Radeon Graphics). Измерение 600 с после
  прогрева 60 с, с активными рельефом, FPV и тепловизором и с программным
  полётом в воздухе на протяжении всего окна.
* **Пределы (без изменений):** медиана <= 16,680 мс и p99 <= 17,665 мс
  (с округлением до 0,001 мс), резидентность GPU <= 2 ГиБ и резидентность CPU
  <= 512 МиБ.
* **Показанные кадры (решение пользователя от 2026-10-22):** время показа
  кадров по PresentMon (сколько каждый кадр оставался на экране) укладывается
  в те же пределы медианы и p99. В Windows допущенный к критерию прогон без
  данных PresentMon — `BLOCKED_EXTERNAL`; без источника времени показа (macOS)
  прогон записывает `displaySource: unavailable`, и решают только часы кадров.
* **Устройство критерия:** **наименее производительный встроенный GPU** среди
  всех протестированных, то есть тот, у которого самая низкая средняя оценка
  по допущенным к критерию прогонам WebGL2 и WebGPU (при равенстве решает
  худший p99). TASK-073 пройдена, только если это устройство проходит **и на
  WebGL2, и на WebGPU**. Пока у каждого протестированного встроенного GPU нет
  допущенных прогонов на обоих бэкендах, наименее производительный неизвестен,
  и решение — `BLOCKED_EXTERNAL`.
* **Всё остальное** (дискретные GPU, другие размеры холста и масштабы,
  профили 120 FPS, исторические прогоны) измеряется и оценивается здесь, но
  никогда не решает.

## 2. Как оценивается прогон

Каждый действительный прогон получает оценку из 100 относительно целевого
интервала `T = 1000 / min(display refresh, profile FPS)` мс:

```text
rating = 50 pacing + 20 sustain + 10 median + 10 features + 10 memory

pacing   = 1 at p99 <= 1.06 T, 0 at p99 >= 2 T, linear between
sustain  = 1 - missed / (0.05 * expected frames), floored at 0
           (an interval of k target periods misses k - 1 refreshes)
median   = 1 at p50 <= T, 0 at p50 >= 1.5 T, linear between
features = 1 when terrain, FPV and thermal were held and the scripted
           flight stayed airborne with live input for the whole window
memory   = 1 - max(GPU peak / 2 GiB, CPU peak / 512 MiB), floored at 0

90-100 excellent, 75-89 good, 50-74 usable, below 50 poor
```

* **Оценка сочетания:** среднее последних оценок прогонов WebGL2 и WebGPU
  при 60 FPS для данных компьютера, экрана и GPU (или единственной имеющейся);
  120 FPS оценивается отдельно.
* **Предварительные оценки:** исторические записи, в которых нет какого-либо
  входа (пропущенных обновлений, состояния полёта или резидентности),
  получают за эту часть 0 и показывают диапазон до оценки, которую могла бы
  добавить недостающая часть. Они становятся точными после повторного прогона
  сочетания текущим стендом.
* **Без оценки:** программные или безголовые GPU, окна короче 600 с или
  прогрев короче 60 с, скрытые вкладки, холсты с изменившимся размером и
  прогоны, во время которых машина спала (настенное время опережает
  монотонное более чем на 2 с; macOS приостанавливает `performance.now()` во
  сне), получают `BLOCKED_EXTERNAL` и не оцениваются.
* **Сопоставимость:** оценки сравнивают прогоны на одном и том же рельефе.
  Прогоны на однотайловой фикстуре CC0 (`fixture`) намного легче прогонов на
  сгенерированных рельефе FABDEM, зданиях Overture и наложении материалов
  (`geodata`) и завышают производительность.

## 3. Оценки по сочетаниям

| Компьютер | Экран | GPU (класс) | Рельеф | Оценка, 60 FPS | Оценка, 120 FPS |
| --- | --- | --- | --- | --- | --- |
| MacBook Air M4 (Mac16,12, 16 GB) | 2560 x 1440 desktop mode @ 59.88 Hz (emulated 1920 x 1080 window) | Apple M4 (8-core GPU) (integrated) | fixture | 70-90 (provisional) | not run |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | geodata | 33-53 (provisional) | not run |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | geodata | 62-82 (provisional) | 0-20 (provisional) |
| MacBook M5 (14-inch) | Built-in Liquid Retina 2880 x 1864, UI 1710 x 1107 @ 59.88 Hz, 2x scale | ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version) (integrated) | fixture | 90 (excellent) | not run |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | geodata | 69 (usable) | not run |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | geodata | 38 (poor) | not run |

Значения ячеек таблиц — это машинный вывод `node scripts/gpu-ratings.mjs table`
и остаются на английском.

Примечания:

* **MacBook Air M4:** 2026-10-21, до сцены P3-P6 (без зданий, без наложения
  материалов, без программного полёта), в плавающем окне с эмулированной
  областью просмотра. Поэтому компонент полёта равен 0, а число пропущенных
  обновлений не записано. Прогон не учитывается для критерия и должен быть
  повторён.
* **RTX 4050 на внешнем дисплее:** захваты P7 от 2026-10-22 над районом в
  Израиле. Пропущенные обновления — это сообщённые интервалы длиннее 18,5 мс
  (нижняя граница); память GPU — пик процесса GPU по счётчикам Windows; кэш
  рельефа и состояние полёта в сводках отсутствуют. Дискретный GPU: никогда
  не решает.
* **Intel iGPU на встроенной панели 144 Гц:** прогоны P7 на панели от
  2026-10-22 при 1920 x 1200, поэтому не допущены к критерию. Кадры и
  пропущенные обновления выведены из сообщённого среднего FPS. WebGPU при
  60 FPS оценён в 70-90, WebGL2 — в 54-74; профиль 120 FPS достиг в среднем
  лишь 58,7 и 83,7 FPS.
* **Intel iGPU на внешнем дисплее (прогоны критерия):** 2026-10-23, Chrome 155
  с `--force_low_power_gpu`, сбалансированное питание, 1920 x 1080 при 1x на
  внешнем мониторе 59,88 Гц над районом в Израиле, с рельефом, FPV и
  тепловизором и с программным полётом в воздухе на протяжении всех 600 с. Оба
  прогона — FAIL. WebGL2: медиана 16,655 мс, p99 27,685 мс, 447 пропущенных
  обновлений; время показа по PresentMon — медиана 17,052 мс и p99 57,041 мс,
  а 10 191 из 35 660 представленных кадров так и не были показаны. WebGPU:
  медиана 16,670 мс, p99 24,040 мс, 378 пропущенных; p99 показа 50,008 мс,
  3 929 из 35 713 кадров не показаны. Процесс GPU Chrome использовал только
  общую память (без выделенной видеопамяти), поэтому оба бэкенда рендерили на
  GPU Intel (медиана занятости GPU 11,4 и 11,2 мс). Внешний монитор подключён
  к GPU NVIDIA, поэтому каждый кадр переходит между адаптерами и компонуется
  DWM (режим представления `Composed: Flip`); дисплей 1920 x 1080, которым
  управляет сам GPU Intel, не измерялся. Исторические строки этого ноутбука
  теперь содержат полные строки рендерера, записанные их захватами.
* **Intel iGPU на собственной панели (прогоны критерия):** 2026-10-23, та же
  конфигурация на встроенной панели, переключённой на 1920 x 1080 при 60 Гц и
  масштабе 100%, так что дисплеем управляет GPU Intel (GPU NVIDIA простаивал
  в P8). Оба прогона — FAIL с оценкой 38. Каждый представленный кадр был
  показан (режим представления `Hardware Composed: Independent Flip`), но около
  3% удерживались на два обновления: WebGL2 — медиана 16,670 мс, p99 42,430 мс,
  1 061 пропущенное обновление, p99 показа 33,395 мс; WebGPU — медиана
  16,665 мс, p99 41,965 мс, 1 035 пропущенных, p99 показа 33,375 мс. Медиана
  занятости GPU 11,4 и 11,9 мс, p99 15,2 и 18,5 мс. Темп кадров здесь хуже,
  чем через монитор на GPU NVIDIA, поэтому этот GPU не проходит не из-за
  копирования между адаптерами. 45-секундная диагностика темпа (WebGL2)
  связывает поздние кадры с потерянными сигналами вертикального гашения: 281
  из 282 поздних представлений совпадают с ожиданием `GpuVSyncThread` Chrome
  длиной в два или три обновления, Chrome отбрасывает эти кадры (`BACKFILL`),
  а GPU Intel в это время простаивает; работа CPU и GPU на кадр такая же, как
  у своевременных кадров. На странице без нагрузки на той же панели сигнал
  потерян лишь для 4 из примерно 3 593 обновлений, то есть потеря связана с
  нагрузкой сцены. Ни 13 мс синтетической работы GPU на кадр (0,36% поздних),
  ни 15 мс работы CPU основного потока на кадр (0,2% поздних) её не
  воспроизводят; какая часть нагрузки сцены её вызывает, не выяснено.
* **MacBook M5:** 2026-10-22, стенд до переработки, рельеф-фикстура. Темп
  кадров был отличным (медиана 16,665 мс, p99 17,670 мс, ни одного
  пропущенного обновления), но программный полёт упал примерно через 11 с, а
  холстом было окно 1710 x 985, а не 1920 x 1080 при 1x. Второй прогон того же
  дня исключён, потому что машина проспала его с закрытой крышкой.

## 4. Состояние критерия

`node scripts/gpu-ratings.mjs decide` сообщает **`BLOCKED_EXTERNAL`**:
протестированы три встроенных GPU (Apple M4, Intel Graphics в ноутбуке с
RTX 4050, Apple M5). У Intel iGPU есть допущенные к критерию прогоны на обоих
бэкендах, на внешнем мониторе и на собственной панели, и все четыре — FAIL
(p99 часов кадров 24,040-42,430 мс, p99 показа 33,375-57,041 мс; оценки 38-75). У M4 и M5 пока нет
допущенного прогона, поэтому наименее производительный встроенный GPU
неизвестен; если это Intel iGPU, TASK-073 не пройдена. Компьютерам Mac нужны
10-минутные захваты WebGL2 и WebGPU на дисплее 1920 x 1080 при масштабе 1x (
внешний монитор 1920 x 1080 или масштабированный режим 1920 x 1080 с окном,
заполняющим экран при DPR 1).

## 5. Все прогоны

| Компьютер | Экран | GPU (класс) | Бэкенд / профиль | Холст | Рельеф | Медиана / p99 мс | Пропуски | Критерий | Оценка |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MacBook Air M4 (Mac16,12, 16 GB) | 2560 x 1440 desktop mode @ 59.88 Hz (emulated 1920 x 1080 window) | Apple M4 (8-core GPU) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | fixture | 16.680 / 17.665 | n/a | INFO | 70-90 (provisional: missed refreshes not recorded) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.670 / 27.085 | 1579 | INFO | 32-52 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 27.085 | 1477 | INFO | 34-54 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1200 at 1x | geodata | 14.280 / 21.920 | 1080 | INFO | 54-74 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1200 at 1x | geodata | 7.040 / 20.930 | 0 | INFO | 70-90 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 120 FPS | 1920 x 1200 at 1x | geodata | 14.080 / 22.320 | 36780 | INFO | 0-20 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 120 FPS | 1920 x 1200 at 1x | geodata | 13.770 / 21.040 | 21780 | INFO | 0-20 (provisional: flight, memory not recorded) |
| MacBook M5 (14-inch) | Built-in Liquid Retina 2880 x 1864, UI 1710 x 1107 @ 59.88 Hz, 2x scale | ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version) (integrated) | webgl2 60 FPS | 1710 x 985 at 1x | fixture | 16.665 / 17.670 | 0 | INFO | 90 (excellent) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.655 / 27.685 | 447 | FAIL | 63 (usable) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.670 / 24.040 | 378 | FAIL | 75 (good) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.670 / 42.430 | 1061 | FAIL | 38 (poor) |
| RTX 4050 laptop (Windows 11, 13th Gen Intel) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 41.965 | 1035 | FAIL | 38 (poor) |

## 6. Добавление прогона

```bash
node scripts/check-gpu-perf.mjs --backend webgl2 --fps 60 --geodata PATH --machine "LABEL" --screen "LABEL" --out test-results/gpu/LABEL-webgl2-60
node scripts/gpu-ratings.mjs add test-results/gpu/LABEL-webgl2-60/run-record.json
node scripts/gpu-ratings.mjs table
node scripts/gpu-ratings.mjs decide
```

Запускайте каждое сочетание от сети, с открытой крышкой и не трогая машину
весь захват: клавиши инструктора в приложении ставят на паузу, сбрасывают
или вносят отказы. Вставьте вывод `table` в разделы 3 и 5 (здесь и в
английском источнике), обновите раздел 4 по выводу `decide` и выполните
`npm run check:docs`.
