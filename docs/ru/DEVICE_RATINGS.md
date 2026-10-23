# Рейтинги устройств (TASK-073)

<!-- source-sha256: fabc0879a56df5ecca625cd810facda3240cc84289e3003e046e45469093da9b -->

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
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | geodata | 33-53 (provisional) | not run |
| MacBook Air M4 (Mac16,12, 16 GB) | 2560 x 1440 desktop mode @ 59.88 Hz (emulated 1920 x 1080 window) | Apple M4 (8-core GPU) (integrated) | fixture | 70-90 (provisional) | not run |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11) (integrated) | geodata | 62-82 (provisional) | 0-20 (provisional) |
| MacBook M5 (14-inch) | Built-in Liquid Retina 2880 x 1864, UI 1710 x 1107 @ 59.88 Hz, 2x scale | ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version) (integrated) | fixture | 90 (excellent) | not run |

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
  лишь 58,7 и 83,7 FPS. Этому GPU нужны прогоны при 1920 x 1080, прежде чем
  критерий можно будет решить.
* **MacBook M5:** 2026-10-22, стенд до переработки, рельеф-фикстура. Темп
  кадров был отличным (медиана 16,665 мс, p99 17,670 мс, ни одного
  пропущенного обновления), но программный полёт упал примерно через 11 с, а
  холстом было окно 1710 x 985, а не 1920 x 1080 при 1x. Второй прогон того же
  дня исключён, потому что машина проспала его с закрытой крышкой.

## 4. Состояние критерия

`node scripts/gpu-ratings.mjs decide` сообщает **`BLOCKED_EXTERNAL`**:
протестированы три встроенных GPU (Apple M4, Intel Graphics в ноутбуке с
RTX 4050, Apple M5), и ни у одного пока нет допущенного к критерию прогона,
поэтому наименее производительный неизвестен. Каждому нужны 10-минутные
захваты WebGL2 и WebGPU на дисплее 1920 x 1080 при масштабе 1x (для Mac —
внешний монитор 1920 x 1080 или масштабированный режим 1920 x 1080 с окном,
заполняющим экран при DPR 1).

## 5. Все прогоны

| Компьютер | Экран | GPU (класс) | Бэкенд / профиль | Холст | Рельеф | Медиана / p99 мс | Пропуски | Критерий | Оценка |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgl2 60 FPS | 1920 x 1080 at 1x | demo | 16.670 / 19.910 | 43 | INFO | 72-82 (provisional: memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgpu 60 FPS | 1920 x 1080 at 1x | demo | 16.665 / 19.645 | n/a | BLOCKED_EXTERNAL | not rated |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), paced at 60 Hz | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgl2 60 FPS | 1920 x 1080 at 1x | demo | 16.665 / 19.565 | n/a | BLOCKED_EXTERNAL | not rated |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 125% scaling | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgl2 60 FPS | 1536 x 826 at 1.25x | demo | 16.670 / 19.005 | n/a | BLOCKED_EXTERNAL | not rated |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgl2 60 FPS | 1316 x 640 at 1x | stress-tileset | 16.670 / 23.880 | 349 | INFO | 66 (usable) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgl2 60 FPS | 1316 x 640 at 1x | stress-tileset | 16.685 / 34.260 | 947 | INFO | 29 (poor) |
| MacBook Air M4 (Mac16,12, 16 GB) | 2560 x 1440 desktop mode @ 59.88 Hz (emulated 1920 x 1080 window) | Apple M4 (8-core GPU) (integrated) | webgl2 60 FPS | 1920 x 1080 at 1x | fixture | 16.680 / 17.665 | n/a | INFO | 70-90 (provisional: missed refreshes not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | n/a | n/a | BLOCKED_EXTERNAL | not rated |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgl2 60 FPS | 1920 x 1080 at 1x | geodata | 16.670 / 27.085 | 1579 | INFO | 32-52 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | External 1920 x 1080 60 Hz (DISPLAY5) | ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11) (discrete) | webgpu 60 FPS | 1920 x 1080 at 1x | geodata | 16.665 / 27.085 | 1477 | INFO | 34-54 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11) (integrated) | webgl2 60 FPS | 1920 x 1200 at 1x | geodata | 14.280 / 21.920 | 1080 | INFO | 54-74 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11) (integrated) | webgpu 60 FPS | 1920 x 1200 at 1x | geodata | 7.040 / 20.930 | 0 | INFO | 70-90 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11) (integrated) | webgl2 120 FPS | 1920 x 1200 at 1x | geodata | 14.080 / 22.320 | 36780 | INFO | 0-20 (provisional: flight, memory not recorded) |
| RTX 4050 laptop (Intel Core 7 240H, 16 GB, Windows 11) | Internal 1920 x 1200 144 Hz panel (DISPLAY1), 100% scaling | ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11) (integrated) | webgpu 120 FPS | 1920 x 1200 at 1x | geodata | 13.770 / 21.040 | 21780 | INFO | 0-20 (provisional: flight, memory not recorded) |
| MacBook M5 (14-inch) | Built-in Liquid Retina 2880 x 1864, UI 1710 x 1107 @ 59.88 Hz, 2x scale | ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version) (integrated) | webgl2 60 FPS | 1710 x 985 at 1x | fixture | 16.665 / 17.670 | 0 | INFO | 90 (excellent) |

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
