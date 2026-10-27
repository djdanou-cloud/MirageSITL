# Рейтинги устройств (TASK-073)

<!-- source-sha256: 7f52319212ea582cb86acbac4d0c1532ac1cbaa951dade4cb8892f82ba550949 -->

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
* **Сопоставимость:** оценки сравнивают прогоны на одном и том же рельефе и
  сцене. От самой лёгкой к самой тяжёлой: `demo` (демонстрационная сцена от
  2026-10-17, без рельефа, FPV и тепловизора), `fixture` (однотайловая фикстура
  CC0), `stress-tileset` (341 синтетический тайл без текстур) и `geodata`
  (сгенерированные рельеф FABDEM, здания Overture и наложение материалов —
  текущая приёмочная сцена). Более лёгкие сцены завышают производительность.
  Оценка сочетания берётся по его последним прогонам, поэтому столбец рельефа
  показывает рельеф, на котором получена эта оценка.

## 3. Оценки по сочетаниям

| Компьютер | Экран | GPU (класс) | Рельеф | Оценка, 60 FPS | Оценка, 120 FPS |
| --- | --- | --- | --- | --- | --- |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | geodata | 33-53 (provisional) | not run |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | stress-tileset | 29 (poor) | not run |
| MacBook Air M4 (Mac16,12, 16 GB) | 2560 x 1440 desktop mode @ 59.88 Hz (emulated 1920 x 1080 window) | Apple M4 (8-core GPU) (integrated) | fixture | 70-90 (provisional) | not run |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | geodata | 62-82 (provisional) | 0-20 (provisional) |
| MacBook M5 (14-inch) | Built-in Liquid Retina 2880 x 1864, UI 1710 x 1107 @ 59.88 Hz, 2x scale | ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version) (integrated) | fixture | 90 (excellent) | not run |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | geodata | 69 (usable) | not run |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | geodata | 92 (excellent) | not run |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling, only display | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | geodata | 100 (excellent) | not run |

Значения ячеек таблиц — это машинный вывод `node scripts/gpu-ratings.mjs table`
и остаются на английском.

Примечания:

* **MacBook Air M4:** 2026-10-21, до сцены P3-P6 (без зданий, без наложения
  материалов, без программного полёта), в плавающем окне с эмулированной
  областью просмотра. Поэтому компонент полёта равен 0, а число пропущенных
  обновлений не записано. Прогон не учитывается для критерия и должен быть
  повторён.
* **RTX 4050 на внешнем дисплее:** оценка получена по захватам P7 от
  2026-10-22 над районом в Израиле. Пропущенные обновления — это сообщённые
  интервалы длиннее 18,5 мс (нижняя граница); память GPU — пик процесса GPU по
  счётчикам Windows; кэш рельефа и состояние полёта в сводках отсутствуют.
  Дискретный GPU: никогда не решает. Более ранние прогоны того же сочетания
  на более лёгких сценах: демонстрационная сцена от 2026-10-17 оценена в 72-82
  (медиана 16,670 мс, p99 19,910 мс, 43 пропущенных обновления за 600 с,
  пересчитано по сохранённым в репозитории интервалам), а захваты
  stress-tileset от 2026-10-21 со стоящим на земле аппаратом — в 66 при схеме
  питания Balanced (p99 23,880 мс, 349 пропусков) и в 29 при максимальной
  производительности (p99 34,260 мс, 947 пропусков; GPU постоянно сбрасывал
  частоты до холостого хода). Демонстрационный зонд WebGPU от 2026-10-17
  (120 с), два демонстрационных зонда на встроенной панели (120 с и 30 с) и
  10-секундный пробный прогон WebGPU P6 перечислены, но не оценены: они короче
  600 с.
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
  воспроизводят. Бисекция нашла причину в самом стенде: сэмплер `nvidia-smi`,
  который `check-gpu-perf.mjs` опрашивает с частотой 1 Гц, при каждом запросе
  задерживает сигнал вертикального гашения панели Intel (полная сцена: 0,37%
  поздних без него, 1,99% с ним на 1 Гц, 12,55% на 10 Гц; PresentMon и
  `typeperf` ничего не добавляют). Поэтому отказы этих прогонов хотя бы
  частично являются артефактом измерения; они остаются записанными как
  измерено.
* **Intel iGPU на собственной панели без `nvidia-smi` (прогоны критерия):**
  2026-10-24, та же конфигурация после того, как `check-gpu-perf.mjs` перестал
  опрашивать `nvidia-smi` для GPU, не являющегося NVIDIA (частоты записаны как
  недоступные с причиной). Оба по-прежнему FAIL, с небольшим отрывом, и
  оценены в 92 и 91: WebGL2 — медиана 16,665 мс, p99 19,960 мс, 88 пропущенных
  обновлений, p99 показа 19,297 мс; WebGPU — медиана 16,665 мс, p99 20,140 мс,
  81 пропущенное, p99 показа 19,926 мс. Показан каждый кадр (`Hardware
  Composed: Independent Flip`); медиана занятости GPU 12,3 и 12,1 мс, p99 15,2
  и 18,3 мс.
* **Intel iGPU на собственной панели как единственном дисплее (прогоны
  критерия):** 2026-10-24, тот же стенд с отключённым внешним монитором, так
  что встроенная панель (1920 x 1080 при 60 Гц, масштаб 100%) была
  единственным и поэтому основным дисплеем. Chrome в Windows берёт часы кадров
  от вертикального гашения основного дисплея (`ui/gl/vsync_thread_win_dxgi.cc`);
  в прежних прогонах на панели основным был внешний монитор на GPU NVIDIA,
  поэтому темп тех прогонов задавали часы другого дисплея. Оба прогона — PASS
  с оценкой 100: WebGL2 — медиана 16,665 мс, p99 17,310 мс, 0 пропущенных
  обновлений, p99 показа 17,279 мс; WebGPU — медиана 16,665 мс, p99
  17,310 мс, 2 пропущенных, p99 показа 17,281 мс. Показан каждый кадр
  (`Hardware Composed: Independent Flip`); медиана занятости GPU 13,6 и
  13,7 мс, p99 15,1 и 15,0 мс (WebGPU: 48 из 41 399 представлений дольше
  16,67 мс против 633 из 41 340 в предыдущем прогоне WebGPU).
* **MacBook M5:** 2026-10-22, стенд до переработки, рельеф-фикстура. Темп
  кадров был отличным (медиана 16,665 мс, p99 17,670 мс, ни одного
  пропущенного обновления), но программный полёт упал примерно через 11 с, а
  холстом было окно 1710 x 985, а не 1920 x 1080 при 1x. Второй прогон того же
  дня исключён, потому что машина проспала его с закрытой крышкой.

## 4. Состояние критерия

`node scripts/gpu-ratings.mjs decide` сообщает **`BLOCKED_EXTERNAL`**:
протестированы три встроенных GPU (Apple M4, Intel Graphics в ноутбуке с
RTX 4050, Apple M5). Последняя допущенная к критерию пара Intel iGPU, на
собственной панели как единственном (и поэтому основном) дисплее, проходит
критерий (PASS) на обоих бэкендах (p99 17,310 мс на WebGL2 и WebGPU, p99
показа 17,279 и 17,281 мс, оценка 100); все шесть его прежних прогонов, с
внешним монитором на GPU NVIDIA в роли основного дисплея, — FAIL. Поэтому в
Windows захваты критерия выполняются на основном дисплее. У M4 и M5 пока нет
допущенного прогона, поэтому наименее производительный встроенный GPU
по-прежнему неизвестен. Компьютерам Mac нужны
10-минутные захваты WebGL2 и WebGPU на дисплее 1920 x 1080 при масштабе 1x (
внешний монитор 1920 x 1080 или масштабированный режим 1920 x 1080 с окном,
заполняющим экран при DPR 1).

## 5. Все прогоны

| Компьютер | Экран | GPU (класс) | Бэкенд / профиль | Холст | Рельеф | Медиана / p99 мс | Пропуски | Критерий | Оценка |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgl2 60 FPS | 1920 x 1080 at 1x | demo | 16.670 / 19.910 | 43 | INFO | 72-82 (provisional: memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgpu 60 FPS | 1920 x 1080 at 1x | demo | 16.665 / 19.645 | n/a | BLOCKED_EXTERNAL | not rated |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), paced at 60 Hz | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgl2 60 FPS | 1920 x 1080 at 1x | demo | 16.665 / 19.565 | n/a | BLOCKED_EXTERNAL | not rated |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 125% scaling | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgl2 60 FPS | 1536 x 826 at 1.25x | demo | 16.670 / 19.005 | n/a | BLOCKED_EXTERNAL | not rated |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgl2 60 FPS | 1316 x 640 at 1x | stress-tileset | 16.670 / 23.880 | 349 | INFO | 66 (usable) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgl2 60 FPS | 1316 x 640 at 1x | stress-tileset | 16.685 / 34.260 | 947 | INFO | 29 (poor) |
| MacBook Air M4 (Mac16,12, 16 GB) | 2560 x 1440 desktop mode @ 59.88 Hz (emulated 1920 x 1080 window) | Apple M4 (8-core GPU) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | fixture | 16.680 / 17.665 | n/a | INFO | 70-90 (provisional: missed refreshes not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | n/a | n/a | BLOCKED_EXTERNAL | not rated |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.670 / 27.085 | 1579 | INFO | 32-52 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11) (discrete) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 27.085 | 1477 | INFO | 34-54 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1200 at 1x | geodata | 14.280 / 21.920 | 1080 | INFO | 54-74 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1200 at 1x | geodata | 7.040 / 20.930 | 0 | INFO | 70-90 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 120 FPS | 1920 x 1200 at 1x | geodata | 14.080 / 22.320 | 36780 | INFO | 0-20 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 120 FPS | 1920 x 1200 at 1x | geodata | 13.770 / 21.040 | 21780 | INFO | 0-20 (provisional: flight, memory not recorded) |
| MacBook M5 (14-inch) | Built-in Liquid Retina 2880 x 1864, UI 1710 x 1107 @ 59.88 Hz, 2x scale | ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version) (integrated) | webgl2 60 FPS | 1710 x 985 at 1x | fixture | 16.665 / 17.670 | 0 | INFO | 90 (excellent) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.655 / 27.685 | 447 | FAIL | 63 (usable) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.670 / 24.040 | 378 | FAIL | 75 (good) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.670 / 42.430 | 1061 | FAIL | 38 (poor) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 41.965 | 1035 | FAIL | 38 (poor) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 19.960 | 88 | FAIL | 92 (excellent) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 20.140 | 81 | FAIL | 91 (excellent) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling, only display | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 17.310 | 0 | PASS | 100 (excellent) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal panel at 1920 x 1080 60 Hz (DISPLAY1), 100% scaling, only display | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11) (integrated) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 17.310 | 2 | PASS | 100 (excellent) |

## 6. Добавление прогона

```bash
node scripts/check-gpu-perf.mjs --backend webgl2 --fps 60 --geodata PATH --machine "LABEL" --screen "LABEL" --out test-results/gpu/LABEL-webgl2-60
node scripts/gpu-ratings.mjs add test-results/gpu/LABEL-webgl2-60/run-record.json
node scripts/gpu-ratings.mjs table
node scripts/gpu-ratings.mjs decide
```

Запускайте каждое сочетание от сети, с открытой крышкой и не трогая машину
весь захват: клавиши инструктора в приложении ставят на паузу, сбрасывают
или вносят отказы. В Windows захватывайте на основном дисплее: Chrome задаёт
темп каждого окна по вертикальному гашению основного дисплея. Вставьте вывод `table` в разделы 3 и 5 (здесь и в
английском источнике), обновите раздел 4 по выводу `decide` и выполните
`npm run check:docs`.
