# SPECS_SIMULATION_ENGINES.md

### Выбор данных NACA6409 (2026-10-20, TASK-033)

Оператор выбрал NACA6409 и NeuralFoil для новой модели профиля.
`scripts/generate-neuralfoil-polar.py` создаёт
`tests/fixtures/polars/naca6409-neuralfoil.json` офлайн по аналитическим
координатам четырёхзначного профиля NACA через внутреннее приближение Kulfan
в NeuralFoil. Подъёмная сила, сопротивление, момент, переход и достоверность
берутся непосредственно из модели `xxxlarge`. Это нейросетевой суррогат,
а не измерения. Зависимости закреплены в `scripts/neuralfoil-requirements.txt`;
фикстура содержит версии пакетов, хеши исходников/весов и координаты.

Сетка: углы от -30 до +30 градусов с шагом 0.5 градуса; Re = 1000, 5000,
10000, 20000, 40000, 60000, 100000, 200000, 500000 и 1000000; только Mach=0.
Настройки: nCrit=9, переход на верхней/нижней поверхности=1. Все значения
сохраняются, включая прогнозы низкой достоверности. Резервного XFOIL,
подгонки коэффициентов, заполнения пропусков и продолжения за срыв нет.

Холодный диагностический поиск интерполирует линейно по углу и логарифмически
по Re. Достоверность равна минимуму участвующих узлов; значение ниже 0.9
добавляет `low-confidence`. Это инженерный фильтр, не гарантия точности.
За границами сетки значения ограничиваются с флагом `outside-table`;
ненулевой Mach добавляет `unsupported-mach`. Нечисловые запросы,
неположительный Re и отрицательный Mach отклоняются. Потребитель сохраняет
флаги. Момент относится к сечению, а не к наклону ротора. NeuralFoil не
определяет взаимодействие следов, нагрев мотора, батарею или планер.
Эти модели и производственная привязка BET остаются отдельной работой.

Генератор запускается в закреплённом окружении Python; `--check` повторяет
расчёт в памяти и требует точного совпадения файла без перезаписи. Тесты:
`python -m unittest discover -s tests -p test_neuralfoil_polar.py`.
Исторические сравнения SDA1075/UIUC сохраняют идентичность профиля и допуски.
Подмена SDA1075 на NACA6409 не обеспечивает прохождение измеренного допуска.
Новая модель больше не ждёт поляру SDA1075; измеренная точность и допуск
браузерного автопилота пока не подтверждены.

### Численная проверка BET NACA6409 (TASK-033)

Конфигурируемое продолжение ниже заменяет CLI фиксированного ротора и
интерфейс схемы v6, описанные в этом историческом приращении.

`python scripts/check-naca6409-bet.py` проверяет хеш зарегистрированной поляры
и синтетическое происхождение, собирает существующий native-пример
`propeller_points` и вычисляет равномерный поток и кольцевой BEM с концевыми/
корневыми потерями и закруткой при 1000/3000/6000/9000 RPM и J=0/0.2/0.4
(24 случая). Ротор явно синтетический: две лопасти, радиус 0.15 м, корень
0.045 м, постоянная хорда 0.025 м, крутка 15 градусов, 28 средних полос,
восемь азимутов, rho=1.225 кг/м3, mu=1.789e-5 Па с, скорость звука 340 м/с.
Идентичность измеренного винта не используется.

Native-запрос повторяет коэффициенты NeuralFoil при Mach=0 на Mach=0.3 как
явное несжимаемое приближение; данные сжимаемости и поправки не создаются.
Native-флаги отмечают выход за его пределы. Исходная поляра и её отдельный
диагностический поиск по-прежнему поддерживают только Mach=0.
Независимый Python-код интегрирует осевые нагрузки сечений и решает уравнение
импульса диска с равномерным потоком 90 бисекциями. Native CT/CP должны совпасть
с точностью 1e-9 абсолютной плюс 1e-8 относительной; невязка импульса <=1e-9
от max(1 Н, rho*n^2*D^4). Кольцевые невязки <1e-9 в безразмерном native-масштабе
силы; некорректный, нечисловой или несошедшийся вывод означает отказ.

Оба решателя сохраняют минимум достоверности NeuralFoil по всем участвующим
ячейкам прямоугольника конечных углов/Re сечений. Консервативная проверка может
отметить неиспользованные внутренние ячейки; низкая достоверность не усредняется.
Значение ниже 0.9, выход за таблицу, native-поляру или импульсную область
исключают случай из screened независимо от численного совпадения. CM/переход
сохраняются в исходной таблице; ядра ротора используют CL/CD. Проверка момента
профиля, переходных процессов или следа не заявляется.

`test-results/validation/naca6409-bet.json` содержит геометрию, допущения,
коэффициенты/ошибки/флаги случаев, хеши фикстуры/исполняемого файла/исходников
и версию Rust. `scripts/validate-models.mjs` запускает проверку и добавляет
обязательный массив `surrogateValidation` в схему отчёта v6 (v5 отклоняется).
`numericalStatus` отделён от `measuredFidelity: unvalidated`. Новый раздел не
обеспечивает измеренный допуск и не меняет неудачные результаты UIUC.
Производственная привязка BET ABI/сессии остаётся открытой.

### Конфигурируемый синтетический набор BET (TASK-033)

По указанию оператора синтетическая геометрия служит базой реализации;
конкретный измеренный ротор для продолжения программной работы не требуется.
`scripts/check-rotor-bet.py` принимает `--config PATH --report PATH`; значения
по умолчанию — `tests/fixtures/rotors/synthetic-bet-suite.json` и
`test-results/validation/rotor-bet.json`. Прежний CLI NACA6409 передаёт работу
этому решателю. `scripts/generate-neuralfoil-polar.py --airfoil NACA0012`
демонстрирует независимое создание поляры; четырёхзначные имена NACA
нормализуются и проверяются. Профиль по умолчанию — NACA6409, байты его
существующей фикстуры сохраняются.

Схема набора v1 требует `provenance: synthetic` и 1..32 конфигурации с
уникальными ID. Каждая выбирает свой профиль и зарегистрированную по хешу
фикстуру поляры. Поля ротора: `bladeCount` (целое 1..16), `radiusM`
(0.001..10 м), `rootRadiusRatio` (0..0.99), `strips` (целое 1..64),
`azimuthSamples` (целое 1..64) и `span`. Строка span содержит [радиус/радиус
законцовки, хорда/радиус законцовки, крутка в градусах]; 2..64 строго
возрастающих строки покрывают активный корень до 1, относительная хорда
0.0001..2, крутка -60..60 градусов. Средние полосы линейно интерполируют
распределение. Native-решатель дополнительно проверяет геометрию/квадратуру.

Каждая конфигурация также задаёт плотность (0.05..2 кг/м3), вязкость
(1e-8..0.001 Па с), скорость звука (1..10000 м/с) и 1..128 различных точек
[RPM,J], где RPM=0.001..100000 и J=0..5. Некорректные, повторные, отсутствующие,
нечисловые или несогласованные профиль/фикстура отклоняются до решателя.
Это границы парсера, а не экспериментально проверенная область полёта.
Каждый решатель получает геометрию, среду и таблицу своей конфигурации;
независимый эталон принимает ту же явную конфигурацию без изменяемой глобальной
геометрии. Прежние численные допуски и проверки достоверности/Mach сохраняются.
Тесты проверяют масштабирование силы/мощности при масштабировании геометрии,
линейное влияние числа лопастей при заданном состоянии, интерполяцию размаха,
независимый выбор профиля и отклонение некорректных конфигураций.

Матрица по умолчанию содержит двухлопастной NACA6409 с постоянной хордой,
трёхлопастной NACA6409 с сужением/круткой и четырёхлопастной NACA0012 с
сужением (всего 72 равномерных/кольцевых случая). Схема отчёта v2 сохраняет
хеш набора и полные определения конфигураций, хеши поляр каждой конфигурации,
идентичность случаев, численный статус и количества screening. Схема
model-report v7 заменяет схему одного профиля v6 обязательным списком сводок
конфигураций; количества вычисляются из входного набора, а не фиксированного
ротора. Версии 5/6 и переименование точности суррогата в измеренный PASS
отклоняются. Оба профиля остаются суррогатами NeuralFoil. Измеренная точность —
отдельные доказательства; производственная интеграция BET ABI/сессии открыта.


<!-- source-sha256: 189137475826061ece3dbe88b6fcd3e8c1214d381961c7c32c985523a0d47494 -->

Английский источник: [Source of truth](../SPECS_SIMULATION_ENGINES.md). Изменения спецификации обновляют оба языка в одной задаче.


Версия 1.0 · 2026-10-15. **Целевой контракт** TASK-016..059. Реализованный
`DemoDynamics` — отдельный учебный stub, не реализация приведённых моделей.
Бинарный transport: [SPECS_SHARED_MEMORY.md](SPECS_SHARED_MEMORY.md).
Работы/приёмка: [PROJECT_ROADMAP.md](PROJECT_ROADMAP.md).

## 1. Инварианты backend и единицы

SI, NED/FRD, quaternion body→NED. Один владелец интегрирования rigid body.
BET отдаёт wrench собственному rigid-body/contact solver; JSBSim интегрирует
сам и получает согласованный contact impulse. Нельзя интегрировать одну
массу дважды в JSBSim и Rapier/Jolt. Общий интерфейс — целевой TS facade:

```ts
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number]; // w,x,y,z
export type BackendKind = 'demo' | 'bet' | 'jsbsim';
export interface ModelDescriptor {
  modelId: number; sha256: string; kind: BackendKind;
  massKg: number; inertiaBodyKgM2: Float64Array; // 3x3 row-major, SPD
  rotorCount: number; rotorCapacity: 32;
}
export interface StepInput {
  dtS: number; tickLo: number; tickHi: number;
  motorDuty: Float64Array; // capacity 32, values [0,1]
  surfaceDeflectionsRad: Float64Array;
  windNedMps: Float64Array; // length 3
  temperatureK: number; pressurePa: number; densityKgM3: number;
}
export interface TruthOutput {
  positionNedM: Float64Array; quaternionBodyToNed: Float64Array;
  velocityNedMps: Float64Array; angularVelocityBodyRadS: Float64Array;
  accelerationNedMps2: Float64Array; specificForceBodyMps2: Float64Array;
  rotorOmegaRadS: Float64Array;
  batteryVoltage: number; batteryCurrentA: number; validityFlags: number;
}
export interface DynamicsBackend {
  readonly kind: BackendKind;
  initialize(model: ModelDescriptor, hz: 400 | 800 | 1200): void;
  reset(seed: number): void;
  stepInto(input: StepInput, output: TruthOutput): void;
  dispose(): void;
}
```

Все arrays выделяются при initialize, capacity проверяется, output
перезаписывается in-place. Во время step запрещены fetch/await/JSON,
аллокации JS/WASM, logging и grow. dt равен выбранному `1/hz`; изменение
только paused/reset. Invalid model (не-SPD inertia, NaN, отрицательная
масса, неверный quaternion, превышение capacity) отклоняется до arm.

Gravity не зашивается в HIL acceleration: `f_b=R_nb^T(a_n-g_n)`.
При неподвижном аппарате с FRD/NED `f_b≈[0,0,-9.80665]` m/s²;
в свободном падении `f_b≈0`. Нулевая скорость не означает нулевой IMU acc.

## 2. BET: геометрия, поляры, интерфейс

Лимиты первой реализации: <=32 роторов, <=64 radial stations на лопасть,
<=64 azimuth quadrature samples, counts заданы при init и не растут в step.
Для rotor hub ось `+z_h` — положительная ось тяги, отличается от body Down;
`q_hb` преобразует hub→body. Spin sign `s=±1`, omega>=0.

```ts
export interface PolarTable {
  alphaRad: Float64Array; // strictly increasing; cover reverse and stalled flow
  reynolds: Float64Array; // positive; interpolate in log(Re)
  mach: Float64Array; // nonnegative
  cl: Float64Array; cd: Float64Array;
  // Flattened index = (iMach*nRe + iRe)*nAlpha + iAlpha.
  sourceSha256: string;
}
export interface RotorGeometry {
  id: number; bladeCount: number; spinSign: -1 | 1;
  radiusM: number; rootCutoutM: number; polarId: number;
  radialStationM: Float64Array; chordM: Float64Array;
  twistRad: Float64Array; quadratureWidthM: Float64Array;
  hubPositionBodyM: Vec3; hubToBody: Quat;
  shaftInertiaKgM2: number; bearingViscousNmPerRadS: number;
  azimuthSamples: number;
}
export interface RotorStepInput {
  densityKgM3: number; dynamicViscosityPaS: number; speedOfSoundMps: number;
  airVelocityAtHubHubMps: Float64Array; // Air velocity minus hub velocity, in hub axes.
  bodyAngularVelocityHubRadS: Float64Array;
  collectivePitchRad: number; cyclicCosRad: number; cyclicSinRad: number;
  motorTorqueMagnitudeNm: number; // Zero for a free rotor.
  dtS: number;
}
export interface RotorState {
  omegaRadS: number; azimuthRad: number;
  inducedAxialVelocityMps: number;
  flapConeRad: number; flapCosRad: number; flapSinRad: number;
  flapCosRateRadS: number; flapSinRateRadS: number;
}
export interface RotorOutput {
  aerodynamicForceHubN: Float64Array; // length 3
  aerodynamicMomentHubNm: Float64Array; // length 3; moment ABOUT HUB
  transmittedMomentHubNm: Float64Array; // Air moment minus dH/dt.
  aeroShaftTorqueNm: number; // Signed Qair along the positive hub axis.
  shaftPowerW: number; // Motor drive power = motor torque magnitude * omega.
  omegaRadS: number; validityFlags: number;
}
export interface RotorEngine {
  initialize(geometry: RotorGeometry, polar: PolarTable): void;
  reset(initial: RotorState): void;
  stepInto(input: RotorStepInput, out: RotorOutput): void;
}
```

`alpha`, `CL`, `CD`, RPM не являются независимыми задаваемыми параметрами
одного шага: alpha выводится из потока/геометрии, CL/CD — из polar, RPM —
из omega. Для стендового теста допускается явно помеченный prescribed-RPM
режим; он не используется для авторотации. `RPM=omega*60/(2*pi)`.
В debug telemetry alpha/CL/CD по элементам пишутся в заранее выделенный
буфер по запросу decimation, без новых arrays на каждом шаге.

## 3. Уравнения blade element и передача wrench

Для элемента радиуса r и азимута ψ: `e_r=[cosψ,sinψ,0]`,
`a=[0,0,1]`, `e_t=s(a×e_r)`, `r_h=r*e_r`.
Относительная скорость воздуха в плоскости элемента:

\[
v_{rel}=v_{air,hub}-\omega_{body,h}\times r_h
           -\Omega r e_t-v_i a,
\quad v_\perp=v_{rel}-(v_{rel}\cdot e_r)e_r.
\]

`v_i` положительно для induced flow в направлении `-a`; внешний wake
от других роторов добавляется отдельно и не учитывается дважды в v_air.
При `U=|v_perp|<1e-6 m/s` силы элемента нулевые, atan2 не вызывается.

\[
U_t=-v_\perp\cdot e_t,\quad U_a=-v_\perp\cdot a,
\quad\phi=\operatorname{atan2}(U_a,U_t),
\]
\[
\beta(r,\psi)=\theta_{collective}+twist(r)
                 +\theta_c\cos\psi+\theta_s\sin\psi,
\quad \alpha=\operatorname{wrap}_{[-\pi,\pi)}(\beta-\phi),
\quad Re=\rho Uc/\mu,\quad Ma=U/c_{sound}.
\]
\[
\hat d=v_\perp/U,\quad \hat l=s(\hat d\times e_r),
\quad dF=\tfrac12\rho U^2c\,dr\,(C_L\hat l+C_D\hat d),
\quad dM=r_h\times dF.
\]

При mirror spin/pitch convention тяга сохраняется, shaft torque меняет
знак. Интеграция по r и ψ включает bladeCount и нормированное azimuth
average, не дополнительное умножение на число samples. Поляры с CD<0,
NaN или неоднозначным order отклоняются. За пределами Re/Mach таблицы
детерминированно clamp + OutsideValidity, а не скрытая экстраполяция.
Покрытие stall/reverse flow обязательно для заявленного flight envelope.

TASK-019 реализует lookup в `native/bet/src/polar.rs`. `PolarTable`
заимствует оси и таблицы вызывающей стороны и проверяет их один раз:
непустые оси, длина таблицы `nMach*nRe*nAlpha`, конечные и строго
возрастающие оси, `Re>0`, `Ma>=0`, конечные коэффициенты и `CD>=0`. Lookup
трилинейный по `(Ma, ln Re, alpha)` и вычисляется сначала по alpha, затем по
ln Re, затем по Mach. Каждая координата вне своей оси, включая alpha,
ограничивается границей (clamp) и выставляет `OUTSIDE_POLAR_VALIDITY` (бит 1
флагов выхода); не-finite запрос возвращает NaN коэффициенты с этим флагом.
Вызывающая сторона заранее приводит alpha к `[-pi, pi)`. Lookup не выделяет
память.

Динамика ротора, где `Q_air=a·M_air` — **signed** аэромомент:

\[
J\dot\Omega=\tau_{motor}+sQ_{air}-\tau_{bearing}(\Omega),
\quad H_h=sJ\Omega a,
\quad M_{hub}=M_{air}-\left({dH\over dt}\right)_{inertial,h}.
\]

Производная H включает `omega_body×H` и изменение оси при flap/gimbal.
Передача body torque только как Q_air при отдельном интегрировании RPM
теряет spin-up/gyro momentum. Если motor reaction уже получен из этой
формулы, второй раз `-s*tau_motor` добавлять нельзя. Inertia ledger явно
разделяет spin degree of freedom и body inertia, без двойного учёта.

Для всех роторов:

\[
F_b=\sum_i R_{hb,i}F_{h,i},\quad
M_b=\sum_i\left(r_{b,i}\times R_{hb,i}F_{h,i}
                         +R_{hb,i}M_{hub,i}\right).
\]

### Inflow, соосные роторы и авторотация

Первый inflow solver — явно ограниченный axial model. Для валидации hover:
`T≈2*rho*A*v_i*|v_i|`; это не универсальная формула vortex-ring/авторотации.
Динамический inflow содержит собственное состояние и bounded итерации
(максимум 4/step); отсутствие сходимости помечает OutsideValidity.
Coaxial model учитывает расстояние, overlap, направление wake и перенос
энергии; запрещён произвольный «коэффициент 0.8» без данных/источника.

Free rotor: torque motor=0; RPM развивается из положительных/отрицательных
областей аэромомента, inertia и bearing loss. Проверить разгон/замедление,
равновесие и восстановление после изменения потока. Не стабилизировать
RPM искусственным governor. Flapping/coning — отдельные уравнения с
hinge inertia/stiffness/damping и аэромоментом, не декоративный наклон mesh.
Параметры и validity envelope фиксируются в manifest модели.
До эталонных данных автожира статус — experimental, даже если тест balance
прошёл. TASK-022 отвечает за free shaft, TASK-023 за flap, TASK-033 за
модельную валидацию; провалившийся model gate не маскируется UI.

### Экспериментальная coaxial wake reference (TASK-024)

`native/bet/src/coaxial.rs` предоставляет `WakePair`, `CoaxialWake::new(pair,rho)`
и `evaluate(source_thrust_n) -> Result<WakeReport,WakeError>` без аллокаций.
Это эталон стационарной несжимаемой top-hat mixing-jet модели, выведенной из
идеального hover actuator-disk momentum, а не эмпирически откалиброванная карта
соосных роторов. В каждом успешном отчёте experimental=true. Spreading half angle
задан явно как synthetic/configuration parameter, без скрытого efficiency factor.

Диски должны быть соосными и параллельными, receiver расположен downstream вдоль
source hub −z. Поддерживается только source thrust >=0; reverse wakes, swirl,
mutual pressure feedback, oblique flight, VRS, dynamic transport delay и обратная
связь от извлечения энергии receiver исключены. Zero separation — математический
предел сжатого wake, не физическое утверждение о совпадающих дисках. Реальные
pose/ID пары будущий adapter должен сопоставлять с конфигурацией борта.

WakePair содержит различные stable upper_id/lower_id в [0,31], separation_m
[0,1e9], overlap [0,1], source_radius_m/receiver_radius_m [0.001,100],
spread_half_angle_rad (0,pi/4] и enabled. Плотность — [0.05,2] кг/м³.
Неконечные значения и неверная геометрия отклоняются в конструкторе; source thrust
должна быть конечной, неотрицательной и давать ideal launch speed <=100 м/с.
Отрицательная тяга и неподдерживаемые скорости отклоняются даже при disabled interception.

Пусть A_s=pi*R_s². Ideal hover сжимает launch area до A_0=A_s/2 и даёт
u_0=sqrt(T/(rho*A_0)), source ideal kinetic power P_0=T*u_0/2. На расстоянии d
используются явная геометрия расширения и сохраняющая импульс core velocity:

\[
R_w=R_s/\sqrt{2}+d\tan\theta,\quad A_w=\pi R_w^2,\quad
u_w=u_0{R_s/\sqrt{2}\over R_w},\quad \rho A_w u_w^2=T.
\]

Переданный overlap умножается на меньшую из wake/receiver areas; автоматического
решателя геометрического пересечения дисков нет. При receiver area A_r
interception area A_i=overlap*min(A_w,A_r), f=A_i/A_w, g=A_i/A_r.
Disabled coupling задаёт A_i=0. Добавляется только delta_v_h=(0,0,−g*u_w) к
существующей air-minus-hub velocity receiver, один раз. Нельзя одновременно
добавлять её как receiver induced velocity: это двойной учёт source wake.
Source self-inflow отдельный. Area-averaged uniform velocity — приближение;
нелинейная нагрузка лопасти частично покрытого диска пространственно не разрешается.

В отчёте раздельны advected momentum и kinetic-power budgets:

\[
P_w=P_0{R_s/\sqrt{2}\over R_w},\quad
P_{received}=fP_w,\quad P_{bypass}=(1-f)P_w,\quad P_{mix}=P_0-P_w\ge0,
\]
\[
\Pi_{received}=fT,\quad \Pi_{bypass}=(1-f)T,\quad
P_{received}+P_{bypass}+P_{mix}=P_0,\quad
\Pi_{received}+\Pi_{bypass}=T.
\]

Это потоки воздуха, а не дополнительная тяга receiver или motor-power credit.
P_0 — вычисленная ideal hover source power, не измеренная shaft power; полное
энергетическое замыкание двух роторов с реальными airfoil/shaft models не
заявляется. Mixing loss — пассивный air-energy sink. Disabled interception
сохраняет баланс, направляя оставшийся wake flux в обход receiver, и не меняет
ввод ротора. При положительном spreading angle u_w стремится к нулю с расстоянием,
поэтому receiver приближается к independent-rotor result. Overlap линейно
масштабирует interception.

Независимый синтетический `tests/fixtures/rotors/coaxial.json` содержит параметры,
аналитические expected fluxes, provenance и зарегистрированный SHA-256.
Угол 0.1 rad — выбор сценария, а не результат подгонки измерений.
Fixture/native/WASM поля сравниваются с absolute 1e-9; общие budget checks
допускают 1e-9 + 1e-12*|source| с учётом floating-point scale. Disabled/zero-overlap
требуют точного равенства независимому wrench; far-field test использует 1e-6 N/Nm.
Native allocator probe включает 1e6 wake evaluations с нулём allocation calls/bytes.
Тестовые scalar/SIMD WASM exports проверяют fixture, budgets, decoupling и 1e6
varying-thrust evaluations без allocator traps или memory growth. Production C ABI,
application backend и model registry не меняются; reference не включён в demo
и не является валидацией подготовки пилотов.

### ESC, батарея и механические отказы

Целевые варианты ESC — явно выбираемый first-order duty/RPM governor
или электромеханический torque model, без двух конфликтующих spool ODE.
Torque model: `I_m=clamp((duty*V-k_e*Omega)/R_m)`, `tau_m=k_t*I_m`,
с регламентированными current/regeneration limits. Батерея:

\[
V=V_{oc}(SOC)-IR_{int},\quad \dot{SOC}=-I/Q_C,\quad
I={V_{oc}-\sqrt{V_{oc}^2-4R_{int}P}\over2R_{int}}.
\]

При недостижимом P ток/мощность ограничиваются до допустимой области,
выставляется power-limited. При R→0 используется предел I=P/Voc.
P включает ESC efficiency и house load, токи/теплопотери не считаются
дважды. Электрические и механические states обновляются согласованно.

`motor-loss power-cut` обнуляет/масштабирует motor torque, сохраняет
пассивную аэродинамику, RPM/inertia и gyro effects. `instant-thrust-loss`
масштабирует force/aero moment конкретного ротора мгновенно как **идеальный
сценарный fault**, без заявления физической эквивалентности обрыву питания;
модель помечается OutsideValidity для energy-validation. Индексы стабильны
по motor manifest и не совпадают автоматически с номером MAVLink channel.

### Атмосфера и детерминированные порывы (TASK-032)

Схема конфигурации `atmosphereFromState(unknown)` принимает только конечные
temperatureK [180,330] и pressurePa [1000,120000], вычисляя плотность
[0.05,2] кг/м³, вязкость и скорость звука; плотность нельзя переопределить.
`isaTroposphere` использует геопотенциальную высоту [0,11000] м, T=288.15−0.0065h,
p=101325(T/288.15)^(9.80665/(287.05287*0.0065)), rho=p/(287.05287T),
a=sqrt(1.4*287.05287T) и вязкость Sutherland: mu0=1.716e-5 Pa·s,
T0=273.15 K, S=110.4 K. Эти SI-параметры сухого воздуха общие для backends;
задача не подключает погоду к текущему demo или JSBSim.

`Wind` заранее создаёт три потока RNG (IDs 0/1/2), сбрасываемые seed сессии.
На фиксированных 400/800/1200 Гц каждая компонента порыва задаётся
x_next=a*x+sigma*sqrt(3*(1−a²))*(2u−1), a=exp(−2*pi*bandwidthHz/hz),
u в [0,1). Это AR(1) с ограниченными инновациями, стационарной дисперсией sigma²
и полосой полюса в (0,hz/2), синтетическая модель, не Gaussian OU или Dryden.
Mean ограничен ±200 м/с на ось, RMS — [0,50] м/с; слишком малая полоса,
округляющая decay до единицы, отклоняется при настройке.
Вызывающий код владеет NED output длины три; render grouping не продвигает RNG.
Настройка атмосферы может выделять память; шаг ветра использует готовое хранилище.
Проверка аллокаций: `node scripts/bench-wind.mjs`, отчёт test-results/bench/wind.json.

### Эталонные native rotor kernels (TASK-020–023)

Это публичные численные Rust API, проверяемые native и в scalar/SIMD WASM
через опциональный feature `kernel-test-exports`. К работающему demo они не
подключены. Production `bet_step` всё ещё возвращает AERODYNAMICS_UNAVAILABLE:
в ABI v1 нет payload/binding для polar tables. Для включения полного backend
нужен версионированный configuration/polar binding; подставлять постоянный polar
нельзя. Production build script не включает численные тестовые exports.

`blade::Rotor::new(geometry, polar, samples)` один раз проверяет заимствованную
геометрию и вычисляет <=64 azimuth sine/cosine nodes. `evaluate(RotorInput)`
возвращает `Result<RotorWrench, RotorError>` без аллокаций. Массивы станций имеют
одинаковую длину [1,64], строго возрастающие внутренние радиусы, положительные
chord/width, конечный twist; сумма widths равна radius−cutout с допуском 1e-9 м.
Проверяются blade count [1,16], spin ±1, azimuth count [1,64] и положительный
активный span. Runtime input требует конечные векторы/скаляры, плотность
[0.05,2] кг/м³, положительные вязкость и скорость звука, неотрицательную omega.
Переполнение — ошибка, а не успешный результат с нулевой силой.

Каждый элемент следует разделу 3 с локальной скоростью от body rate и знаковым
induced flow. Порядок интегрирования: azimuth, затем radius, вес B/N_az;
station widths уже учитывают радиальное интегрирование, повторное умножение
на blade count запрещено. Wrench задан относительно hub. `flap_load_nm` —
обобщённый hinge torque в базисе (1,cos psi,sin psi): сумма r*dF_z с этими
базисными весами. Дополнительного множителя два здесь нет: нормировка входит
в harmonic modal inertia. Polar clamp flags объединяются OR. При постоянных
CL/CD без inflow и body rates независимые непрерывные эталоны annulus:

\[
T={B\rho c C_L\Omega^2\over6}(R^3-r_0^3),\qquad
Q_{air}=-{sB\rho c C_D\Omega^2\over8}(R^4-r_0^4).
\]

`inflow::AxialInflow` реализует ограниченный знаковый normal-working actuator disk.
Пусть sigma=sign(T), V=−sigma*v_air,z, L=|T|/(2*rho*A). Целевая величина —
положительный корень w уравнения w*(w+V)=L; в hover это sqrt(L). При V>=0
корень рационализирован для исключения потери точности. Знаковая целевая
скорость sigma*w ограничена заданным положительным пределом. Релаксация
точна при постоянных входах: vi_next=vi_target+(vi−vi_target)*exp(−dt/tau).
Итерационного solve нет (ноль <= четырёх итераций), скрытого неограниченного
Newton loop тоже нет. Выдаётся абсолютный target residual
|2*rho*A*vi*|vi−v_air,z|−T|. Hover tests требуют <=1% тяги и проверяют
сходимость переходного процесса на 400/800/1200 Гц.

Снижение против тяги (V<0), transverse speed >1 м/с и target clipping выставляют
outside_validity. Inflow в VRS/windmill-brake/авторотации не валидирован. Для T=0
target равен нулю, включая нулевые RPM/flow. Это одностороннее замыкание
thrust-to-inflow; при совместном использовании с blade torque обновлять тягу
на границах tick и учитывать ошибку связи. Измеренные rotor data не заявляются.

`shaft::Shaft` интегрирует J*dOmega/dt=tau_motor+s*Q_air−b*Omega. Motor/air torque
постоянны на tick; вязкое bearing damping интегрируется точно через expm1
с непрерывным пределом b=0. RPM governor отсутствует. Модуль скорости не
становится отрицательным: попытка реверса останавливает его на нуле с
reverse_limited; обратное вращение требует другой модели. Выдаются кинетическая
энергия J*Omega²/2 и residual удерживаемого torque. Аэродинамический момент нужно
пересчитывать для новой скорости. Тесты проверяют пассивный экспоненциальный
спад энергии, разгон от потока, торможение, equilibrium residual <0.01 Nm,
снятие потока и сходимость dt. Синтетические constant-coefficient polars
проверяют механику, а не точность airfoil.

`flapping::HingeModel` — эталон zero-offset rigid-blade linear small-angle hinge,
полученный Galerkin-проекцией I*D²beta+C*D beta+(K+I*Omega²)beta=Q,
где D=partial_t+s*Omega*partial_psi. Параметры I0/K0/C0 суммируются по лопастям;
cos/sin modal parameters ровно вдвое меньше из-за ортогональности.
При w=s*Omega и wd=s*dOmega/dt модальные ускорения:

\[
\ddot\beta_0=Q_0/I_0-(C_0/I_0)\dot\beta_0-(K_0/I_0+w^2)\beta_0,
\]
\[
\ddot\beta_c=2Q_c/I_0-(C_0/I_0)\dot\beta_c-(K_0/I_0)\beta_c
 -2w\dot\beta_s-((C_0/I_0)w+\dot w)\beta_s,
\]
\[
\ddot\beta_s=2Q_s/I_0-(C_0/I_0)\dot\beta_s-(K_0/I_0)\beta_s
 +2w\dot\beta_c+((C_0/I_0)w+\dot w)\beta_c.
\]

RK4 удерживает generalized loads и spin acceleration на tick, вычисляя spin
в моменты стадий. Валидность требует суммы |beta_mode|<=заданного предела<=0.2 rad;
превышение выдаётся явно, а не скрывается clamp углов. Нужны dt<=0.01 s и
 dt*(max spin over step+sqrt(K0/I0)+C0/I0)<=1. Переданные blade loads используют
flat-disk reference: aeroelastic feedback, offset hinges, teetering stops,
elastic blades, stall и измерения автожира вне этого диапазона.

`momentum::angular_momentum` использует сокращённый blade-distribution ledger:
J=sum integral r²dm, Hx=−s*J*Omega*beta_c+(J/2)*beta_s_dot,
Hy=−s*J*Omega*beta_s−(J/2)*beta_c_dot, Hz=s*J*Omega*cos²(beta0).
Поперечные члены первого порядка по cyclic flap; это не полный тензор инерции
гибкой лопасти. `transmitted_moment` вычисляет полную дискретную инерциальную
производную для переданного H:

\[
M_{hub}=M_{air}-{H_{next}-H_{previous}\over dt}
 -\omega_{body,h}\times{H_{next}+H_{previous}\over2}.
\]

Учтены spin-up, изменения cone/cyclic и flap-rate momentum; повторно добавлять
motor reaction нельзя. Shaft/flap DOFs нельзя дублировать в body inertia.
Generalized aerodynamic loads и transmitted moments раздельны. Frame aggregation
и rigid-body integration относятся к будущим TASK-027/028. Все API отклоняют
неконечные параметры и используют фиксированное хранилище.

Независимые JSON-эталоны tests/fixtures/rotors зарегистрированы по SHA-256,
явно синтетические, содержат вывод и единицы. Native allocator probe считает
вызовы/байты с positive allocating control на 1e6 совместных kernel steps.
WASM tests собирают scalar/SIMD с trapping allocator, проверяют tail counts
1/3/5/63, сравнивают аналитические результаты (absolute 1e-9 N/Nm, oscillator
1e-8 rad) и исполняют миллион шагов dynamics без memory growth. Это не
подтверждение экспериментальной аэродинамики или M4/RTX throughput.

## 4. WASM ABI и SIMD

Rust crate `native/bet`; wrapper `packages/wasm-bet`. JSBSim — отдельный
Emscripten artifact. Scalar обязателен; SIMD128 — optional feature-detected
artifact, только после scalar reference. Float64 для физики/интеграции;
переход на float32 требует error budget и отдельных convergence tests.

### Дополнительный ABI привязанных роторов v1 (TASK-033)

Этот отдельный интерфейс сохраняет прежний ABI арены роторов v1.
`bet_bound_version`, `bet_bound_init(config,len,arena,arenaLen)`,
`bet_bound_step(arena,input,out,dt)`, `bet_bound_reset(arena)` и
`bet_bound_dispose(arena)` используют непересекающиеся области вызывающей
стороны с выравниванием 8 байт. Заголовок конфигурации: 128 байт;
u32 version/totalBytes/nAlpha/nRe/nMach/nStations/bladeCount/spinSign/
azimuthSamples по смещениям 0/4/8/12/16/20/24/28/32; 36..39 нулевой резерв;
f64 radius/root/inertia/bearing/dt/initialOmega/inflowTau/inflowLimit/
minConfidence по 40/48/56/64/72/80/88/96/104; 112..127 нулевой резерв.
Далее четыре массива f64 станций (radius/chord/twist/width), оси
alpha-radian/Re/Mach и CL/CD/confidence в порядке (Mach,Re,alpha).
Ограничения: 361/32/8/64 и 16384 ячейки. Native-инициализатор проверяет
и копирует данные в арену с заголовком 64 байта; размер арены = 64 + размер
конфигурации.

Вход: 128 байт; u32 version по 0, 4..7 нулевой резерв; f64 плотность/
вязкость/скорость звука по 8/16/24, относительная скорость воздуха ступицы[3]
по 32, угловая скорость корпуса[3] по 56, collective/cos-cyclic/sin-cyclic
по 80/88/96, модуль момента двигателя по 104; 112..127 нулевой резерв.
Выход использует описанное ниже расположение полей ротора размером 128 байт
через отдельный версионированный интерфейс. Заголовок арены: u32
magic/bytes/memoryPages/reserved по 0/4/8/12; f64 omega/induced по 16/24;
32..63 нулевой резерв. После инициализации конфигурация неизменна.

Каждый шаг прогнозирует состояние свободного вала и осевого потока на
полушаге, вычисляет нагрузки в середине шага и обновляет состояние полного
шага по этим нагрузкам. Выход содержит аэродинамическую силу/момент середины
шага и новое состояние вала/потока. Переданный момент вычитает разностную
производную dH/dt и векторное произведение угловой скорости корпуса на H.
Маховое движение отключено (cone=0). Флаги: 2 выход за поляру, 4 низкая
достоверность влияющего угла ячейки, 8 выход за применимость осевого потока,
16 предел обратного вращения. Конечные прогнозы с флагами отличаются от
численных ошибок. Отрицательные статусы совпадают с прежними; ошибки не
меняют выход и состояние. Reset восстанавливает начальную скорость и нулевой
поток, dispose аннулирует арену. Рост памяти после init отклоняется.
Новая раскладка SAB или допуск автопилота из этого интерфейса не следуют.

Конфигурация dt допускает 400/800/1200 Гц и 4800 Гц для офлайн-эталона;
часы сессии по-прежнему ограничены 400/800/1200 Гц. `BetFlightDynamics`
прогнозирует скорость, угловую скорость и ориентацию корпуса на полушаге для
относительного потока, затем интегрирует суммарную силу/момент. Явная
конфигурация задаёт манифест, карту поляр, атмосферу, пределы моментов моторов,
микшер и начальные состояния корпуса/валов; предполагаются жёсткие роторы
без махового движения и свободный полёт. Контакт, батарея и автопилот этим
не реализуются.

`node scripts/check-bet-runtime.mjs` сохраняет 18 сравнений по десять секунд
для 4/6/8 роторов, scalar/SIMD, 400/800/1200 Гц против 4800 Гц с прежними
допусками 0.1 м и 0.5 градуса. `--allocation` считает миллион native-шагов с
положительным контролем, миллион шагов активного ротора каждого WASM-варианта
и миллион шагов неподвижного корпуса с четырьмя роторами и нулевой гравитацией.
JS-проверки требуют ноль GC, менее 0.01 добавочного байта/шаг, стабильную память
WASM и обнаружение аллоцирующего контроля. Это проверки ПО, не измеренная
аэродинамическая валидация или гарантия реального времени целевого устройства.
Отчёты `bet-runtime.json` и `bet-runtime-allocation.json` в
`test-results/validation/` содержат хеши исходников и артефактов. Model-report v8
требует обе диагностики и `runtimeStatus`, отклоняя v7 и старше. Устаревшие,
отсутствующие или некорректные данные блокируют допуск runtime; проваленные
проверки дают fail. Исторические измеренные сравнения сохраняют независимый
статус.

WASM exports: `bet_abi_version()->u32`,
`bet_required_bytes(config_ptr:u32,len:u32)->u32`,
`bet_init(config_ptr:u32,len:u32,arena_ptr:u32,arena_bytes:u32)->u32 handle`,
`bet_step(handle:u32,input_ptr:u32,out_ptr:u32,dt_s:f64)->i32 status`,
`bet_reset(handle:u32,seed:u32)->i32`, `bet_dispose(handle:u32)`.
0 handle = failure. Каждый pointer range проверяется при init, входные
counts/finite — перед step, strides и alignment известны. `repr(C)`;
не переносить Rust Vec/String/bool/enum layout через границу. Memory/arena
выделяется до запуска; baseline budget BET <=64 MiB. Growth после arm — fault.

Rotor output record 128 bytes: offsets 0/24/48 — f64[3] force, air moment,
transmitted moment; 72 omega f64; 80 aero shaft torque f64; 88 shaft power
f64; 96 induced axial velocity f64; 104 cone angle f64; 112 flags u32;
116 reserved u32; 120 signed angular momentum along hub axis f64.
Input/config C headers и Rust offset tests создаёт TASK-018; нельзя cast
произвольный TS object в эти records. Rust/WASM arena не является Main SAB.

TASK-018 реализует эти layouts в `native/bet/src/abi.rs`, отражает их в
`native/bet/include/bet.h` (источник layout, разбираемый тестами Rust и TS)
и в `packages/wasm-bet/src/arena.ts`:

```text
ABI v1 records (little-endian; offsets in bytes; all regions 8-byte aligned)
config header (64):  0 abi_version u32 | 4 config_bytes u32 = 64 + n*2160
                     8 rotor_count u32 (1..32) | 12 rotor_stride u32 = 2160
                     16 dt_s f64 (exactly 1/400, 1/800, 1/1200) | 24..63 reserved = 0
rotor config (2160): 0 id u32 | 4 blade_count u32 (1..16) | 8 spin_sign i32 (+1/-1)
                     12 station_count u32 (1..64) | 16 azimuth_samples u32 (1..64)
                     20 polar_id u32 | 24 radius_m f64 | 32 root_cutout_m f64
                     40 hub_position_body_m f64[3] | 64 hub_to_body f64[4] (w,x,y,z)
                     96 shaft_inertia_kg_m2 f64 | 104 bearing_viscous_nm_per_rad_s f64
                     112 radial_station_m f64[64] | 624 chord_m f64[64]
                     1136 twist_rad f64[64] | 1648 quadrature_width_m f64[64]
                     unused station slots = +0.0
input header (64):   0 rotor_count u32 | 4 rotor_stride u32 = 96 | 8 density_kg_m3 f64
                     16 dynamic_viscosity_pa_s f64 | 24 speed_of_sound_mps f64
                     32..63 reserved = 0
rotor input (96):    0 air_velocity_at_hub_hub_mps f64[3]
                     24 body_angular_velocity_hub_rad_s f64[3] | 48 collective_pitch_rad f64
                     56 cyclic_cos_rad f64 | 64 cyclic_sin_rad f64
                     72 motor_torque_magnitude_nm f64 (>= 0) | 80 flags u32 = 0
                     84..95 reserved = 0
rotor output (128):  as above; flags bit0 AERODYNAMICS_UNAVAILABLE, bit1 OUTSIDE_POLAR_VALIDITY
arena:               64-byte header + configuration copy + n * 64-byte rotor state
                     required_bytes = 64 + config_bytes + n*64
status i32:          0 OK | 1 AERODYNAMICS_UNAVAILABLE | -1 BAD_HANDLE | -2 BAD_POINTER
                     -3 BAD_INPUT | -4 BAD_DT | -5 MEMORY_GROWN | -6 ARENA_TOO_SMALL
                     -7 ABI_MISMATCH
```

Указатели ненулевые, выровнены на 8 байт, находятся внутри текущей линейной
памяти и не ниже экспортированного `__heap_base` (никогда не в статических
данных или стеке Rust); регионы одного вызова не должны перекрываться.
Handle — это указатель arena. `bet_last_error()->i32` сообщает, почему
`bet_required_bytes` или `bet_init` вернули 0. Неизвестные counts, strides,
ненулевые reserved bytes, не-finite значения и геометрия вне диапазона
отклоняются. `bet_step` сначала проверяет весь вход и при отрицательном
статусе не пишет ни одного байта выхода; при статусе >= 0 он перезаписывает
каждую запись ротора. Он возвращает `MEMORY_GROWN`, если линейная память
отличается от размера при инициализации. До подключения версионированного polar-to-kernel binding production ABI
возвращает `AERODYNAMICS_UNAVAILABLE` с NaN в силе, моментах и
аэродинамическом моменте на валу и флагом `AERODYNAMICS_UNAVAILABLE`, а не
выдуманный успех. JS binding пишет входы и декодирует выходы через один
заранее созданный DataView в объекты вызывающей стороны без аллокаций на шаге.

SIMD: без relaxed-simd/fast-math по умолчанию, фиксированный reduction order
в scalar reference; alignment и хвосты 1/3/5/63 элементов тестируются.
`unsafe` ограничен validated memory views и SIMD intrinsics с объяснением.
Scalar/SIMD: abs error force<=1e-6 N, moment<=1e-6 Nm для golden fixtures,
relative<=1e-6 при |reference|>=1; длительные trajectory tolerances отдельно.
Эти допуски — numerical parity, не подтверждение физической достоверности.

## 5. Sensor/EW pipeline

`truth -> ideal sample -> calibrated noise/bias -> EW -> quantization -> MAVLink`.
EW не мутирует truth, attitude renderer, terrain или clocks. Механический
fault — исключение: действует на физический actuator path, а не на GPS.

```ts
export interface GpsSample {
  timeLoUs: number; timeHiUs: number;
  latitudeRad: number; longitudeRad: number; altitudeMslM: number;
  vnMps: number; veMps: number; vdMps: number;
  hdop: number; vdop: number; hdopValid: boolean; vdopValid: boolean;
  fixType: number; satellites: number; satellitesValid: boolean; velocityValid: boolean;
  courseRad: number; courseValid: boolean;
}
export interface ImuSample {
  timeLoUs: number; timeHiUs: number;
  specificForceBodyMps2: Float64Array;
  gyroBodyRadS: Float64Array; magBodyGauss: Float64Array;
  pressurePa: number; differentialPressurePa: number;
  pressureAltitudeM: number; temperatureK: number; updatedMask: number;
}
export interface EwContext {
  dtS: number; simTimeS: number;
  truthNorthM: number; truthEastM: number; truthDownM: number;
}
export interface EwEngine {
  reset(seed: number): void;
  advanceInto(context: EwContext): void; // Every physics step; no allocations.
  distortGpsInto(source: GpsSample, target: GpsSample): void;
  distortImuInto(source: ImuSample, target: ImuSample): void;
}
```

Source и target — разные preallocated buffers. RNG с фиксированным
алгоритмом/seed и раздельными stream IDs по сенсорам; render FPS не меняет
результат. IMU 200/400 Гц, GNSS 5/10 Гц; rational scheduler по ticks без
накопления ошибки на 1200 Гц. Noise specs задают bandwidth/PSD: не добавлять
одинаковую дисперсию white noise независимо от dt без единиц и модели.

### Пространственная экспозиция

Для sphere center c/radius R и cone с axis u/aperture θ:

\[
r=\|p-c\|,\quad
J=\mathbf{1}_{r\le R}\;G(\hat{p-c}\cdot u)
       {P_{rel}\,r_{ref}^2\over\max(r^2,r_{min}^2)},\quad
q=\operatorname{clamp}\left({J-J_{on}\over J_{full}-J_{on}},0,1\right).
\]

Sphere: G=1. Cone: G=0 вне cosθ, внутри — заданный smoothstep taper.
При r=0 использовать axis-neutral G=1, нет деления на ноль. r_min>0,
J_full>J_on>=0 проверяются при конфигурации. Объединение volumes:
sum J с saturation, не случайный порядок обхода. Это **dimensionless
training exposure**, не RF link budget в dBm. Real receiver mapping требует
измерений. На границе объёма допустима явно заданная smooth shell/hysteresis.

### Джамминг GNSS

С фильтрацией severity `q_f += (q-q_f)*(1-exp(-dt/tau))`:

\[
N_{sat}=\min(N_0,\operatorname{round}((1-q_f)N_0+q_fN_{jam})),\quad N_{jam}\in[0,3],
\]
\[
HDOP=\max(HDOP_0,(1-q_f)HDOP_0+q_f HDOP_{jam}),
\quad VDOP\text{ analogous},\quad DOP_{jam}\in[50,99].
\]

При q_f>=0.8 или N_sat<4: fixType=0 (без fix). Восстановление fix
только после q_f<0.6 и N_sat>=4; degraded baseline без fix не превращается
в 3D fix. Пороги — версионированный сценарный preset, не характеристика
реального приёмника. К packet loss/stale measurement нужен отдельный
явный сценарий, а не отправка NaN/переполнение. IMU/barometer не меняются.
Уже худший baseline (например HDOP>99 или N0<3) не улучшается джаммером.
Unknown DOP/satellite validity сохраняется как unknown; численный placeholder
не интерпретируется как хороший DOP или реальное число спутников.

### Грубое смещение и когерентный drift

Step: GPS position получает постоянный `b_ned`; GPS velocity сохраняет
baseline — скачок намеренно не кинематически согласован. Это может дать
большую innovation, но не гарантирует конкретное сообщение EKF/режим.

Drift интегрируется каждый physics step, а не только при GNSS выдаче:

\[
v_d^{k+1}=v_d^k+a_d^k\Delta t,\quad
b^{k+1}=b^k+v_d^k\Delta t+\tfrac12a_d^k\Delta t^2,
\]
\[
p_{GPS}'=p_{GPS}+b,\quad v_{GPS}'=v_{GPS}+v_d.
\]

Типичный сценарный |a_d|=0.1..0.3 m/s², maxSpeed ограничен preset.
При достижении speed cap использовать согласованный piecewise integration
до момента cap, затем постоянную скорость, не clip v после обновления b.
Course/speed пересчитываются из повреждённой horizontal velocity.
Динамика ложной позиции/скорости сама по себе не обеспечивает обход
EK3_VEL_GATE: реакция зависит от covariances, других сенсоров и firmware.

При отключении `hold-offset`: ограниченно затормозить drift velocity,
интегрируя b, затем удерживать offset. `step-to-truth`: явно сбросить b/v
с discontinuity и событием AAR. Не умножать b на fade без соответствующего
изменения производной v. Reset обнуляет все fault states/seed streams.

Для малых NED смещений диагностическая аппроксимация:
`delta_lat=bN/(M+h)`, `delta_lon=bE/((N_curv+h)*cos(lat))`,
`delta_alt_msl=-bD`. В production offsets до 10 км преобразуются через
WGS84 ECEF/local tangent frame и geoid model; near-pole и antimeridian
тестируются. Эллипсоидальная h и MSL H различаются: `H=h-geoidUndulation`.

### Магнитные аномалии

В body sensor frame:

\[
B_b'=R_z(\delta\psi)R_y(\delta\theta)R_x(\delta\phi)B_b+b_{mag,b}.
\]

Углы из `rotationRad=[roll,pitch,yaw]`, bias в gauss. Повреждается только
mag, quaternion truth не поворачивается. Для Earth-fixed аномалии сначала
перевести bias NED→body. Не объявлять toilet bowling гарантированным:
проверять innovation/yaw estimates/траекторию в pinned SITL сценарии.

## 6. MAVLink encoding: обязательные преобразования

Авторитетный формат: [common.xml](https://github.com/mavlink/mavlink/blob/master/message_definitions/v1.0/common.xml).
Имена/единицы сверены 2026-10-15; TASK-037 фиксирует конкретный upstream SHA,
dialect XML hash и генератор. Ссылка master — справочная, не lockfile.

| Message.field | Wire type | Преобразование из модели |
| --- | --- | --- |
| HIL_GPS.time_usec | u64 | sensor sample time, одна согласованная epoch/domain |
| lat / lon | i32 | round(rad*180/pi*1e7), WGS84 |
| alt | i32 | round(MSL metres*1000), up-positive |
| eph / epv | u16 | **HDOP/VDOP×100, unitless**, не метры; unknown=65535 |
| vel | u16 | round(hypot(vN,vE)*100), cm/s, unknown=65535 |
| vn / ve / vd | i16 | round(component*100), cm/s NED |
| cog | u16 | course [0,360) deg×100, unknown=65535 |
| fix_type / satellites_visible | u8 | fix 0/2/3 по доступности; sat unknown=255 |
| yaw extension | u16 | 0=unavailable, north=36000; не путать с cog |
| HIL_SENSOR.x/y/zacc | f32 | specific force FRD, m/s² |
| x/y/zgyro | f32 | rad/s FRD |
| x/y/zmag | f32 | **gauss** (microtesla×0.01) FRD |
| abs_pressure / diff_pressure | f32 | Pa/100 → hPa |
| pressure_alt | f32 | pressure altitude, m, adapter convention fixture |
| temperature | f32 | K-273.15 → degC |
| fields_updated | u32 | только реально обновлённые поля, generated enum |
| HIL_ACTUATOR_CONTROLS.controls | f32[16] | [-1,1], mapping зависит от hardware profile |

Course при horizontal speed<0.05 m/s = unknown. При |component|>327.67 m/s
signed velocity saturates с encoding-clipped diagnostic; не wrap signed int.
Finite/range validation до quantization; reserved sentinel нельзя получать
случайным переполнением. Timestamp sample не заменять временем отправки WS.
Кодек проверяет MAVLink2 CRC_EXTRA, dialect, IDs, seq, truncation и signing
если включён; parser не полагается на границы WebSocket/Serial chunk.

RC override: каналы 1..8: 65535 ignore, 0 release; каналы 9..18:
0/65535 ignore, 65534 release. RC us и normalized actuator controls —
разные контракты. GPS/HIL поддержка конкретной платы/ArduPilot build
проверяется capability gate; отсутствие callback не считается success.

## 7. Numerical acceptance и экспериментальная достоверность

* Analytic blade cases: zero relative airspeed => zero force; CD>=0 drag
  рассеивает relative energy; mirror spin сохраняет thrust/меняет shaft torque;
  torque arm и rotor rotations проверены независимыми golden fixtures.
* Rotor free-spin: мотор не добавляет энергии, bearing dissipative;
  заданный airflow может питать авторотацию. Steady residual
  `|tau_motor+s*Q_air-tau_loss|<0.01 Nm` для эталонного rotor fixture.
* Convergence: выбранные smooth cases 400/800/1200 против 4800 Гц reference
  (offline); ошибка положения<=0.1 m и attitude<=0.5 deg за 10 s,
  без contacts/discontinuities. Прочие envelope tests имеют свои допуски.
* EW: копия truth до/после bit-identical; seed одинаков => одинаковые
  observations; sampled drift derivative согласована с v в допуске
  discretization; encode/decode отличается не более одного wire LSB.
* Stationary HIL, GPS altitude/sign, DOP units, gauss/hPa, monotonic timestamps
  проверяются автоматическими fixtures и pinned native SITL.
* JS allocation instrumentation и WASM allocator counters показывают 0
  allocations/0 bytes per step после warmup; `memory.buffer.byteLength`
  не меняется на 1e6 шагов. Это не доказательство отсутствия browser GC.
* Экспериментальная сверка rotor/airframe и записанный Simulation-on-Hardware — отдельные gates:
  если данных/платы нет, статус BLOCKED_EXTERNAL, а не DONE по synthetic tests.


## Реализованные эталонные ядра: TASK-025–028

Это переиспользуемые эталонные ядра, а не завершённый полётный backend. Мотор,
батарея, суммирование нагрузок рамы и интегратор доступны независимо;
production-вызов `bet_step` по-прежнему возвращает `AERODYNAMICS_UNAVAILABLE`.
Привязка поляр, итерация нагрузки/напряжения, маршрутизация отказов моторов и
выбор backend в Worker пока не подключены. Далее используются SI, FRD и NED.

### ESC и батарея

Выбрана модель приводного момента. Команда duty имеет точную задержку первого
порядка; инерцию вала интегрирует только существующее ядро вала. Константы
момента и противо-ЭДС совпадают в SI. Второго регулятора RPM нет.

$$
d_{n+1}=u+(d_n-u)e^{-\Delta t/\tau},\quad
I=\operatorname{clamp}\left({d_{n+1}V-k_t\Omega\over R_m},0,I_{max}\right),\quad
Q_d=k_tI,\quad P_{mech}=Q_d\Omega,\quad P_{cu}=I^2R_m.
$$

Идеальный PWM ESC с ограничением тока потребляет ток шины `(Pmech+Pcu)/V` при
положительных напряжении и токе. Ограничение меняет фактический duty;
возвращаемая фильтрованная команда не равна фактическому PWM при насыщении.
Нулевое напряжение или жёсткое отключение питания обнуляют приводной момент,
сохраняя скорость вала. Рекуперация, коммутационные потери и температура не моделируются.

Батарея использует линейное напряжение холостого хода от SOC. Мощности моторов
и вспомогательной нагрузки суммируются ровно один раз; устойчивый корень на
ветви малого тока ограничивается источником, током и оставшимся зарядом.

$$
V_{oc}(s)=V_{empty}+(V_{full}-V_{empty})s,\quad V=V_{oc}-IR_b,\quad
I_{req}={2P\over V_{oc}+\sqrt{V_{oc}^2-4R_bP}},\quad
I_{cap}=\min(I_{max},sQ_c/\Delta t,V_{oc}/(2R_b)).
$$

При `Rb=0` используется `Ireq=P/Voc` без ограничения тока максимальной мощностью.
Невыполнимая мощность насыщается на допустимом максимуме; возвращается
`power_limited`, а не отрицательный дискриминант/NaN. Разряженная батарея полностью
отключается. Обновление: `SOC=max(0,SOC-I*dt/Qc)`; мощность источника равна
отданной мощности плюс `I²Rb` при SOC, фиксированном на шаге. Это сосредоточенная
электрическая модель без гарантии химического энергобаланса или ресурса батареи.
Доступную мощность ещё необходимо вернуть актуаторам в будущем backend.

### Суммирование рамы и интегрирование тела

Идентификаторы роторов уникальны, 0..31; максимум 32 крепления. Кватернион wxyz
переводит координаты втулки в FRD. Входной момент уже содержит перенос момента
импульса ротора; повторно добавлять реакцию мотора нельзя.

$$
\mathbf F_b=\sum_i R_i\mathbf F_i,\qquad
\mathbf M_b=\sum_i(\mathbf r_i\times R_i\mathbf F_i+R_i\mathbf M_{hub,i}).
$$

Нативный интегратор использует RK4 с нормализацией кватерниона, постоянной
нагрузкой FRD на шаге, положительной массой и симметричным положительно
определённым тензором инерции, проверенным разложением Холецкого. Гравитация
float64 направлена по +Down. `q` переводит тело в NED; угловая скорость задана
в теле относительно фиксированной локальной NED.

$$
\dot{\mathbf p}=\mathbf v,\quad
\dot{\mathbf v}=R(q)\mathbf F_b/m+(0,0,g),\quad
\dot{\boldsymbol\omega}=J^{-1}(\mathbf M_b-\boldsymbol\omega\times J\boldsymbol\omega),\quad
\dot q={1\over2}q\otimes(0,\boldsymbol\omega).
$$

Допускаются `0<dt<=0.01` и начальное `|omega|*dt<=1`. Контактный прототип сферы
имеет отдельного владельца интегрирования; нельзя применять RK4 и Rapier к одному
телу на одном шаге. `BetRigidBodyBackend` требует отдельного экземпляра памяти
WASM; его резервирование heap нельзя совмещать с ареной роторов.

### Независимый ABI твёрдого тела v1

Это контракт линейной памяти WASM, **не** новая версия SharedArrayBuffer ABI.
ABI арены роторов и межпоточный ABI v2 не изменены. Все double little-endian,
указатели выровнены на 8 байт, области не пересекаются и находятся в памяти;
12 резервных байт заголовка нулевые. Вход 256 байт, выход 128 байт.
`bet_body_abi_version()` возвращает 1; `bet_body_step(input,output,dt)` возвращает 0,
BAD_POINTER (-2), BAD_INPUT (-3) или ABI_MISMATCH (-7), не меняя выход при ошибке.

| Input byte offset | Type / count | Field | Units |
| --- | --- | --- | --- |
| 0 | f64 | mass | kg |
| 8 | f64[9] | row-major body inertia | kg*m² |
| 80 | f64[3] | position NED | m |
| 104 | f64[3] | velocity NED | m/s |
| 128 | f64[4] | body-to-NED quaternion wxyz | 1 |
| 160 | f64[3] | angular velocity body | rad/s |
| 184 | f64[3] | force body | N |
| 208 | f64[3] | moment body | N*m |
| 232 | f64 | gravity magnitude | m/s² |
| 240 | u32 | version = 1 | 1 |
| 244 | u8[12] | reserved = 0 | 1 |

| Output byte offset | Type / count | Field | Units |
| --- | --- | --- | --- |
| 0 | f64[3] | position NED | m |
| 24 | f64[3] | velocity NED | m/s |
| 48 | f64[4] | quaternion wxyz | 1 |
| 80 | f64[3] | angular velocity body | rad/s |
| 104 | f64[3] | coordinate acceleration NED | m/s² |

## Приёмочные ограничения контакта и JSBSim: TASK-029–033

### Прямой контактный ABI v1 (TASK-029)

Рабочий `GroundContact` загружает артефакт команды `node scripts/build-contact.mjs`
через `GroundContact.initialize(bytes, manifest)` до создания изолированных сессий.
Он заменяет выделяющие память оболочки провайдера. Манифест фиксирует Rapier
0.36.0 f64, патч повторного использования буферов, хеши исходников, SHA-256
артефакта и фиксированные 16 MiB памяти. Импорты, общая память, конкурентный
доступ и повторный вход в ABI запрещены. Отдельный lockfile контакта обязателен;
самостоятельный BET сохраняет ABI и аллокатор с ловушкой через явную возможность
композиции `embedded-kernels`.

Все буферы содержат f64; смещения здесь — индексы элементов, а не байты.
`contact_config_ptr`, `contact_input_ptr`, `contact_output_ptr` возвращают
выровненные непересекающиеся области на 1312, 16 и 96 значений.
`contact_abi_version` возвращает 1. `contact_initialize` отклоняет существующую
сессию (-1) и неверную конфигурацию (-2). `contact_step` возвращает 0 при успехе,
-1 для закрытой/аварийной сессии, -2 для неверного ввода, -3 при нечисловой
физике или выходе за область применимости, -6 при выделении памяти.
Ошибка сохраняет опубликованный вывод; ошибка после продвижения навсегда
блокирует сессию. `contact_dispose` идемпотентен. Счётчики вызовов/байтов
накапливаются за рабочие шаги; `contact_allocator_probe` — холодный положительный
контроль, сбрасывающий счётчики. Его нельзя вызывать внутри рабочего прогона,
чтобы стереть свидетельства выделений.

Заголовок конфигурации: [0]=версия 1, [1]=0, [2]=масса корпуса kg,
[3]=радиус сферы корпуса m, [4]=восстановление в [0,1], [5]=трение корпуса,
[6..8]=позиция NED m, [9..11]=скорость NED m/s, [12..15]=единичный кватернион wxyz,
[16..18]=угловая скорость корпуса rad/s, [19..21]=положительная диагональ инерции kg m²,
[22..24]=наружная единичная нормаль плоскости NED, [25]=смещение n·p m,
[26]=ускорение тяжести вниз m/s², [27]=число колёс 0..8, [28..31]=нули.

Каждое колесо начинается с 32+160*i. Поля: [0..2]=центр полностью выпущенного
колеса относительно ЦМ в body FRD m; [3]=неподрессоренная масса kg;
[4]=радиус шины m; [5]=радиус жёсткого обода m (0<обод<шина);
[6]=ход стойки m; [7]=тип (0 линейный, 1 газовый); [8]=жёсткость N/m;
[9]=преднатяг N; [10..11]=демпфирование сжатия/отбоя;
[12]=закон (0 линейный, 1 квадратичный); [13..15]=mu качения/бокового сопротивления/торможения;
[16]=демпфирование шины N s/m; [17]=число узлов 2..64; [18..27]=площадь газа,
объём, давление зарядки, атмосферное давление, показатель, гидравлическая
площадь, плотность жидкости, коэффициент расхода, отверстия сжатия и отбоя
в единицах SI, заданных ниже; [28..31]=нули; [32..95]=деформации шины m;
[96..159]=силы шины N. Неиспользуемые элементы нулевые. Последний узел
покрывает разность радиусов шины и обода. Все значения конечны.

Ввод: [0..2]=внешняя сила body N; [3..5]=внешний момент body N m;
[6..13]=доли торможения в [0,1] (нули для отсутствующих колёс);
[14]=dt строго 1/400, 1/800 или 1/1200 s; [15]=нуль. Вывод:
[0..2]=позиция NED; [3..5]=скорость NED; [6..9]=кватернион wxyz;
[10..12]=угловая скорость body; [13..15]=координатное ускорение NED;
[16..18]=суммарный контактный импульс на корпус N s без внешней силы и тяжести;
[19..21]=контактный угловой импульс в новом body frame N m s без внешнего момента;
[22..24]=диагностическое плечо сферы body m; [25]=число колёс; [26..31]=нули.
Колесо с 32+8*i сообщает ограниченное сжатие стойки m, сжатие шины m,
нагрузку шины N, нагрузку стойки N, избыточное перекрытие шины/обода m,
неограниченное сжатие стойки m, знаковое расстояние колеса от плоскости m и нуль.
Диагностика колёс относится к вычислению сил до интегрирования, состояние
корпуса — к завершённому шагу.

Диагностическая точка сферы не описывает пару сил нескольких контактов.
Для переноса углового импульса требуется `ContactImpulse.momentBodyNms`;
его нельзя восстанавливать векторным произведением одной точки и суммарного
линейного импульса. Только Rapier интегрирует корпус, колёса, призматические
ограничители выпуска/сжатия и жёсткий обод. Внутренние силы стойки равны
и противоположны. Шина действует только при контакте. Силы ограничиваются
физическим ходом и пределом кривой шины, реакции упоров/обода обеспечивают
жёсткие ограничения; исходное перекрытие остаётся в диагностике.
Нельзя выполнять второе интегрирование того же шага через BET/JSBSim.
Плоскость задаётся явно; ABI v2 (TASK-065, ниже) добавляет плоскости на каждый тик для рельефа из опубликованных collision-чанков.

Качение использует кинематическое продольное сопротивление, отдельное боковое
сопротивление и интерполяцию тормоза с регуляризацией ниже 0.1 m/s.
Суммарная касательная сила ограничена max(продольный mu,боковой mu), умноженным
на нормальную нагрузку шины. Закон пассивен, но не моделирует вращение колеса,
статическое проскальзывание, антиюз и поворот. Холодная инициализация проходит
переходы контакта на всех частотах. Рабочее выделение памяти блокирует сессию;
постоянный размер памяти сам по себе недостаточен.
`node scripts/check-contact-binding.mjs` собирает native и WASM из закреплённых
исходников f64 Rapier 0.36.0 (`b716d375efc0201003f0cd9ef7168eee0b62c177`),
проверяет аналитические оракулы силы/энергии и статической нагрузки, паритет
одинаковых исходников native/WASM (позиция <=0.1 m, ориентация <=0.5 градуса)
и ноль вызовов/байтов аллокатора для 0/3/8 колёс при 400/800/1200 Hz (9 миллионов
нативных шагов; модульные тесты отдельно считают 9 миллионов шагов WASM) и пишет
`test-results/validation/task-029-binding.json`. `node scripts/bench-contact.mjs`
(принимает число колёс 0/3/8 и частоту 400/800/1200) выполняет 4,000,000 шагов
прогрева плюс 100,000 шагов прогрева измерительной обёртки, затем измеряет три
окна по 1,000,000 шагов с повторными циклами подъёма/удара и выделяющим
положительным контролем, подтверждая ноль событий GC, <0.01 B/step и ноль
вызовов/байтов аллокатора WASM (`highRateCertified=true`), и пишет
`test-results/bench/contact.json` (или `contact-<wheels>-<hz>.json`). Решение
пользователя от 2026-10-18 откладывает измеренную достоверность NASA; архивное
неудачное сравнение сохраняется и не заменяется синтетическими данными.

### Эталонные упругие силы

`native/bet/src/landing_gear.rs` реализует компоненты силы/энергии без dt,
обновления позиции, владения решателем или заявления готовности контакта.
Выбор источников описан в architecture.md. Конфигурация явно задаётся в SI;
синтетические численные тесты не калибруют измеренное шасси. Нового production
C/SAB ABI нет.

Сжатие x и скорость сближения v положительны при укорочении компонента.
`LinearStrut` использует преднагрузку F0 (N), жёсткость k (N/m), конечный ход (m)
и отдельные коэффициенты линейного (N s/m) или квадратичного (N s²/m²)
демпфирования по направлениям. `GasStrut` — упрощённая однокамерная пружина с
равными площадями вытеснения/давления A (m²), начальным объёмом V0 (m³),
абсолютными давлениями зарядки/среды p0/pa (Pa), показателем политропы n в [1,1.4],
гидравлической площадью Ah (m²), плотностью rho (kg/m³), коэффициентом расхода
Cd в (0,1] и отдельными постоянными площадями отверстий сжатия/отбоя Ao (m²).
Давление зарядки не ниже окружающего, V0-A*travel>0. Исключены тепловое
состояние, сжимаемость жидкости, переменная игла, трение уплотнений и составные
камеры. Эти параметры не являются калибровкой NASA.

$$
F_{e,linear}=F_0+kx,\quad E_{linear}=F_0x+\tfrac12kx^2,\quad V=V_0-Ax.
$$

$$
p=p_0(V_0/V)^n,\quad F_{e,gas}=(p-p_a)A,\quad F_d={\rho A_h^3\over2(C_dA_o)^2}v|v|.
$$

$$
F=\max(0,F_e+F_d),\qquad P_d=(F-F_e)v\ge0.
$$

$$
E_{gas}=\begin{cases}p_0V_0\ln(V_0/V)-p_aAx,&n=1,\\ {p_0V_0\over n-1}[(V_0/V)^{n-1}-1]-p_aAx,&n\ne1.\end{cases}
$$

`ln_1p`/`exp_m1` сохраняют малые изменения давления; при вытесненной доле
u=Ax/V0<1e-4 избыток интеграла газового закона вычисляется аналитическим рядом
до u^5, чтобы избежать потери точности при нулевой избыточной преднагрузке.
При n<=1.4 отброшенный безразмерный член в этой ветви меньше 1e-23. Эффективное
рассеяние вычисляется после ограничения нагрузки. Преднагрузка газа остаётся
внутренней силой при полном разжатии; владелец-решатель должен дать реакцию
упора разжатия. Превышение хода возвращает GearError; вымышленный закон пробоя
или молчаливое продолжение за пределами диапазона не добавляются.

`TireCurve` заимствует 2–64 неизменяемых узла: строго возрастающая деформация
от 0 m, неубывающая нагрузка от 0 N и неотрицательное вертикальное демпфирование
N s/m. Сила интерполируется линейно, энергия точно интегрируется по участкам.
При deflection<=0 нагрузка/энергия/рассеяние нулевые; при положительной
деформации нормальная нагрузка равна max(0,elastic+damping*closureSpeed).
Превышение последнего узла даёт ошибку. Деформация шины не является ходом
стойки или проникновением жёсткой сетки.

`ground_wrench` принимает точку контакта body (m), body-to-NED wxyz, внешнюю
нормаль земли NED, неотрицательную нагрузку N и скорость контакта относительно
земли (m/s). Квадраты норм нормали/кватерниона должны отличаться от 1 не более
чем на 1e-10. Касательная сила — регуляризованное кулоновское трение скольжения
с явными mu>=0 и veps>0:

$$
\mathbf v_t=\mathbf v-\mathbf n(\mathbf v\cdot\mathbf n),\quad
\mathbf F_{NED}=N\mathbf n-\mu N{\mathbf v_t\over\max(|\mathbf v_t|,v_\epsilon)},\quad
\mathbf F_b=R(q)^T\mathbf F_{NED},\quad\mathbf M_b=\mathbf r_b\times\mathbf F_b.
$$

Здесь нет ограничения статического трения, вращения колеса, шинной модели
коэффициента скольжения, торможения или сопротивления качению. Нельзя
одновременно применять силу другого решателя для того же контакта. Все входы
и выходы должны оставаться конечными. Вызов не выделяет память, не расширяет
коллекции, не пишет логи и не изменяет состояние тела. Неверные входы дают
GearError; тестовые WASM-экспорты возвращают NaN.

Заранее заданные синтетические допуски: 1e-9 N/J/W для ручных случаев
силы/энергии, 1e-5 N для производной энергии политропы, 1e-12 относительно для
асимптотики энергии малого сжатия и 1e-10 W для границ пассивной мощности.
Нативные счётчики аллокаций с положительным контролем охватывают 1e6 прогретых
вычислений в существующем численном графе. Scalar и SIMD-enabled тестовые
артефакты выполняют те же скалярные законы с ловушкой аллокаций и неизменной
памятью. Этот автономный модуль не сертифицирует траекторию NASA, живой допуск
рельефа в сессию или физическую модель скольжения шины.

### Сборка JSBSim WASM и bridge ABI v1 (TASK-030)

JSBSim v1.2.3 зафиксирован на коммите
`570e8115a102df8f877b11e0e59b964ea483e3c0`; Emscripten 4.0.15 — на коммите emsdk
`389a68bc35dcff7ebae4614e1615099dafda00d1`. Перед сборкой проверяются HEAD,
чистота отслеживаемых файлов, хеш LGPL-2.1 библиотеки и хеш манифеста SDK.
XML самолёта не поставляется: c172x содержит отдельные ограничения распространения
и не валидирован пилотами. Перед упаковкой требуется проверка лицензии и данных
каждой модели. Нативный smoke использует тот же bridge/исходники, выдаёт 22 конечных
SI double через одну секунду симуляции и **не** проверяет балансировку, паритет
native/WASM или аллокации. Закреплённый SDK Emscripten 4.0.15 собирает WASM-артефакт
и проходит исполнение в модульном Worker Chromium при 400/800/1200 Гц через
`node scripts/check-jsbsim-artifact.mjs`.

Сборка вызывает Python-точки входа Emscripten напрямую на Windows и Unix;
`MIRAGE_PYTHON` и `MIRAGE_CMAKE` выбирают исполняемые файлы, а `EM_CONFIG`
указывает на конфигурацию проверенного SDK. На Windows Ninja должен быть в PATH.
CMake добавляет заголовок POSIX select и компилирует созданную локальную копию
`strutils.cxx`, выбирающую POSIX-тип результата `strerror_r` для musl Emscripten.
Это изменения переносимости, а не динамики upstream; checkout остаётся чистым.
Манифест содержит размеры/хеши артефактов, коммиты исходников/SDK, версию
компилятора, идентификатор патча аллокаций и хеши CMake/bridge/скрипта сборки.
`SOURCE_DATE_EPOCH` закреплён на времени коммита исходников, чтобы строки версии
upstream с `__DATE__`/`__TIME__` не меняли байты артефактов между сборками.
Модуль экспортирует FS, HEAPU8 и HEAPF64 для локальных ресурсов и текущего адаптера.

Настроив `JSBSIM_SOURCE_DIR` и `MIRAGE_EMSDK_DIR`, выполните
`node scripts/build-jsbsim.mjs`, затем `node scripts/check-jsbsim-artifact.mjs`.
Если браузер Playwright отсутствует, задайте `CHROMIUM_PATH`. Отдельный smoke
проверяет происхождение и хеши артефактов, загружает шесть локальных XML
c172x/двигателя/систем в настоящий Worker и проверяет ABI v1, 22 конечных выхода,
одну секунду симуляции на каждой частоте (ошибка времени <=1e-10 с), ошибку нормы
кватерниона <=1e-10, неизменную память 64 MiB, неверные команды и освобождённые
handles. Отчёт — `test-results/validation/jsbsim-artifact.json`; ошибки дают код 1.
XML самолёта обслуживается временным loopback-сервером только для локального
теста и не включается в поставку. Для сравнения второй чистой сборки задайте
`MIRAGE_JSBSIM_OUT` при её сборке и передайте каталог через
`MIRAGE_JSBSIM_COMPARE` при проверке основного артефакта. Совпадение хешей
подтверждает только локальную воспроизводимость повторной сборки.

ABI bridge v1 принимает четыре float64: газ [0,1], элерон/руль высоты/руль
направления [-1,1]. Выход — 22 double: позиция NED фиксированного начала 0..2,
скорость NED 3..5, wxyz тела относительно исходной NED 6..9, угловая скорость
тела 10..12, удельная сила тела 13..15, секунды симуляции 16, высота ASL в метрах
17, модуль гравитации 18, координатное ускорение NED 19..21. Коэффициент футов —
точно 0.3048. Исходные ECEF и поворот в NED фиксируются при инициализации;
векторы тела преобразуются через ECEF в эту исходную систему. Извлечение
кватерниона учитывает пассивную матрицу JSBSim. Координатное ускорение включает
перенос скорости тела; удельная сила — ускорение приложенных сил. JSBSim владеет
интегрированием. Отдельный Worker smoke выше (`check-jsbsim-artifact.mjs`)
проверяет исполнение и идентичность памяти; контактные импульсы, закреплённый
паритет trim/step и счётчики аллокатора WASM/GC проверяются сборкой TASK-031
`--contact` (`check-jsbsim-backend.mjs` и `bench-jsbsim.mjs`) ниже.

## Реализованные сенсорные эталоны: TASK-034–035

`IdealSensors.sampleInto` принимает существующий `BodyTruth`, epoch, split uint64
счётчик тиков/время выборки и ветер NED. Он заполняет готовые записи ABI v2
конечными float64 и признаками идеальных данных; GNSS не синтезируется до задачи
WGS84/геоида. IMU выдаёт угловую скорость тела и удельную силу
`R(q)^T*(aNED-gNED)`: неподвижное прямое тело имеет -g по FRD Z, свободное
падение — ноль. Поле магнитометра переводится из NED gauss в body gauss.
Барометр использует ISA, Pa и высоту `originPressureAltitudeM-positionDownM`
в пределах -1000..11000 м. Идеальный воздушный датчик выдаёт всенаправленное
динамическое давление `0.5*rho*|velocityNED-windNED|²` Pa без модели направления
трубки Пито или сжимаемости.

Выборка использует целочисленную фазу: прибавить частоту сенсора на физическом
тике, при достижении порога выдать выборку и вычесть частоту физики. Частоты —
целые 1..physicsHz; IMU 200/400 Гц и расписания 5/10 Гц дают точное число выборок
за 60 с при 400/800/1200. Выборка происходит на границе тика с квантованием
фазы меньше физического тика; 400 Гц при физике 400 Гц не означает интерполяцию.

Для шума явно заданы RMS после фильтра, полоса Гц, частота выборки и блуждание
смещения на корень секунды. Независимые детерминированные потоки `2*id` и
`2*id+1` дают гауссовские отсчёты Box–Muller с фиксированным объёмом работы.

$$
a=e^{-2\pi f_c/f_s},\quad n_{k+1}=an_k+\sigma\sqrt{1-a^2}\,z_k,\quad
b_{k+1}=b_k+{\sigma_b\over\sqrt{f_s}}\,z'_k,\quad y_k=x_k+n_{k+1}+b_{k+1}.
$$

Здесь `0<fc<fs/2`, sigma — стационарный RMS, а не неуточнённая PSD. Фильтр и
смещение стартуют с нуля; для стационарной статистики переходный процесс исключается.
Двусторонняя дискретная PSD в единицах величины в квадрате/Гц равна
`sigma²*(1-a²)/(fs*(1+a²-2*a*cos(2*pi*f/fs)))` на [-fs/2,fs/2].
`sampleInto(values,out,index)` работает с готовыми float64-массивами и избегает
упаковки числового результата в V8. FIFO задержки фиксированной ёмкости хранит
один scalar на слот с монотонными сроками выдачи/опроса, безопасными целыми
микросекундами, счётчиком переполнений и reset; разным схемам сенсоров нужны
отдельные очереди. Выход содержит срок выдачи и значение; исходные метаданные
момента получения сохраняются отдельно при интеграции. Очередь не меняет
время выборки или истинное состояние.

`node scripts/bench-sensors.mjs all` измеряет связку идеального IMU, рационального
расписания, детерминированного шума и задержки после четырёх миллионов тиков
прогрева с переходом через переполнение 32-битного времени. В шести окнах
N=1e6/2e6 нет GC; обязательный положительный контроль обнаруживает аллокации.
Пробы компонентов (`ideal`, `noise`, `metadata`) изолируют ошибки. Это измерение
аллокаций прогретого Node/V8, а не сертификация времени браузера/M4/RTX или
аллокаций полного полётного backend.

Режим аллокаций `body` выполняет настоящий scalar WASM-адаптер тела перед
сенсорным конвейером при постоянной нагрузке висения. Шесть прогретых окон
N=1e6/2e6 не имеют GC и добавочных B/step; положительный контроль обнаружен,
память WASM стабильна. Компонент `ideal` на каждой итерации проверяет IMU,
магнитометр, барометр и воздушный датчик. Юнит-тесты также выполняют 1e6 шагов
тела в scalar и SIMD128 с ловушкой аллокаций; это критерии численных результатов/
аллокаций, а не измеренная достоверность борта или время целевых устройств.

## Непрозрачные handles JSBSim, холодная балансировка и сопряжение с контактом: TASK-031

Старый ABI v1 сохраняет четыре нормированных управления и 22 выхода SI со
старыми смещениями. Добавочный контакт имеет свой `jsb_contact_abi_version()`:
1 при включении, иначе 0. `node scripts/build-jsbsim.mjs --contact` применяет
исходный патч хранения и `native/jsbsim/patches/contact-impulse.patch`;
манифест фиксирует оба хеша и нативный режим WASM-исключений. XML самолёта
остаётся локальным. Численная приёмка отделена от измеренной достоверности.

`jsb_apply_contact(handle,input,count=6,out,outCount=22)` принимает выровненные
f64: линейный импульс origin-NED N s в 0..2 и угловой импульс относительно ЦМ
body-FRD N m s в 3..5. Вход/выход занимают непересекающиеся 48/176 байт.
Неверные/устаревшие handles, размеры, выравнивание, границы или пересечение
возвращают -1; нечисловой ввод -2; нечисловая физика -4; отсутствие поддержки
или активный встроенный weight-on-wheels -5. Проверка ввода предшествует
изменению. После успешного фиксированного шага допускается одно применение;
повтор отклоняется. Позиция, ориентация и время не меняются. Вызывающая сторона
решает ограничения без отдельного интегрирования корпуса. Шаг корпуса Rapier
из TASK-029 нельзя интегрировать повторно. Загруженное шасси JSBSim владеет
активным контактом с землёй, исключая вторую реакцию.

$$
m_{kg}=m_{slug}{4.4482216152605\over0.3048},\quad I_{SI}=I_{slug\,ft^2}(4.4482216152605)(0.3048),\quad \Delta v_n=J_n/m_{kg},\quad \Delta\omega_b=I_{SI}^{-1}K_b.
$$

`FGPropagate::ApplyBodyImpulse` меняет инерциальную скорость/угловую скорость
body и производные скорости body/local/кватерниона. Истории производных позиции
и кватерниона получают тот же скачок без аллокаций и размазывания Adams-Bashforth;
истории ускорений непрерывных сил сохраняются. Выходные acceleration/specific
force включают импульс, делённый на dt, как усреднённую диагностику отсчёта,
которая повторно не интегрируется.
Это разделение после шага: непрерывные силы пересчитывает следующее обычное
вычисление JSBSim. Дополнительный запуск с нулевым временем или внешняя контактная
итерация более высокого порядка не вставляются; внутренние датчики модели
не переигрываются посреди тика.

`jsb_mass_properties(handle,out,count=10)` возвращает текущую массу kg и полную
row-major инерцию body kg m², включая расход топлива.
`jsb_read_state(handle,out,count=22)` не продвигает время. Холодный
`jsb_set_initial_state(handle,input,count=13)` принимает геоцентрическую широту/долготу rad,
ASL m, roll/pitch/yaw rad, скорости body m/s, угловые скорости body rad/s,
высоту рельефа ASL m. Все значения конечны; границы широты/долготы pi/2 и pi,
высота -1000..1000000 m. RunIC обновляет фиксированное начало; после шага
изменения запрещены. Рабочая область адаптера 104 байта последовательно
обслуживает начальное состояние, массу и импульс. Старые поля управления
сохраняют значение.

Поддерживаются не более 64 загруженных контактов шасси, каждый не более чем
с двумя множителями трения. Ёмкости множителей, плотной матрицы трения и RHS
резервируются при холодной загрузке. Повторное использование/обнуление сохраняет
порядок решателя и значения; динамическая топология запрещена. Контактная сборка
использует нативные WASM-исключения при компиляции/линковке (`-fwasm-exceptions`),
убирая трамплины исключений/виртуальных вызовов из JS. Неподдерживаемая среда
отказывает при холодной компиляции; выделяющий запасной режим не сертифицируется.
См. [исключения Emscripten](https://emscripten.org/docs/porting/exceptions.html).
Обычная старая сборка сохраняет JS-исключения. Первый контактный GC-прогон
этого режима провалился с 75 событиями на миллион шагов; отчёт сохраняется.

`jsb_allocator_probe`, `jsb_allocation_track`, `jsb_allocation_calls` и
`jsb_allocation_bytes` инструментируют malloc/calloc/realloc, выровненные
выделения и C++ new/delete. Холодный положительный контроль обнаруживает
выделение, затем сбрасывает счётчики; сброс при измерении запрещён. Volatile
не позволяет компилятору свернуть чтения через переписывание линкером.
`JsbsimBackend.armHighRate` включает счёт после подготовки/прогрева и блокирует
backend при выделении. Обязательны отдельная память, согласованные стабильные
heap views, непересекающиеся собственные кадры и внешние выходные буферы.
Счётчик не видит JS-выделения: GC проверяется отдельно. Холодные загрузка/trim
между ограниченными полётными окнами явно исключены; стационарный контакт
с землёй развивается непрерывно.

`scripts/check-jsbsim-backend.mjs` сравнивает native/WASM trim, ступенчатое
управление и импульс на 400/800/1200 Hz за десять секунд. Зарегистрированный
`airframes/jsbsim-backend-reference.json` заранее задаёт допуски 0.1 m позиции,
0.5 градуса ориентации, 0.1 m/s скорости, 1e-6 trim и 1e-8 N s импульса.
Стационарный контакт проверяет скорость <0.02 m/s, ускорение <0.05 m/s² и
specific force вверх (местная экваториальная тяжесть около 9.78 m/s² без
принудительных 9.80665). `scripts/bench-jsbsim.mjs` выполняет настоящий адаптер
с пассивным опорным импульсом шести степеней свободы (J=-m v, K=-I omega), без
второго интегрирования позиции/времени, с отдельным наблюдением JS GC,
нативного аллокатора и выделяющего контроля. Эти проверки не устанавливают
целевое реальное время, разрешение распространения модели или измеренную
калибровку. Текущий адаптер остаётся явным мостом управления/контакта;
выбор демо/полётной сессии и готовность автопилота относятся к другим задачам.

Handles bridge теперь содержат поколение: младшие четыре бита выбирают слот,
остальные — поколение. Нулевое поколение недопустимо. Dispose устаревшего handle
ничего не делает; повторное использование слота не открывает старому handle новую
сессию. Перед переполнением поколения слот выводится из оборота. Токен остаётся
непрозрачным; раскладка состояния v1 и типы аргументов не изменены. Входные и
выходные кадры не пересекаются; пересечение отклоняется до изменения управления
или времени. Адаптер также отклоняет несогласованные heap views, невыровненные/
выходящие за память/пересекающиеся кадры и замену памяти во время вызова.

Добавлен необязательный экспорт `jsb_trim(handle,controlsOut,count=4)` для полной
балансировки JSBSim только при холодной настройке. Он инициализирует мотор/смесь,
может выделять память, возвращает управление балансировки и заново фиксирует
начало координат при успехе. После начала шагов вызов отклоняется. Код 0 — успех,
-1 — неверные handle/состояние/кадр, -2 — провал балансировки, -3 — недопустимое
управление. Ошибка может изменить состояние настройки upstream: перед повторной
подготовкой полёта нужно dispose/создание заново. Метод адаптера `trimInto`
отклоняет модуль без этой возможности. Прежний step ABI v1 совместим. Нативная
балансировка не означает измеренную достоверность модели.

`node scripts/check-jsbsim-native.mjs` собирает и запускает настоящий закреплённый
нативный bridge. Проверяются устаревшие handles, неверные/пересекающиеся кадры,
норма wxyz, центральные разности позиции/скорости/ускорения, поворот удельной силы
тела и баланс гравитации. Заданные допуски: 0.1 м/с, 0.1 м/с², 0.05 м/с²;
последний учитывает члены кажущейся гравитации вращающейся Земли, отсутствующие
в скалярном модуле ньютоновской гравитации. Полная нативная балансировка проходит.
Измеренные ошибки: 5.50e-7 м/с, 5.50e-10 м/с² и 0.03392 м/с².

Проба аллокатора использует 250 независимо созданных/сбалансированных окон:
400 тиков прогрева и 4000 измеряемых шагов на окно (всего 1e6). Reset/trim/
разрушение не входят в измерение; полёт остаётся в коротком эталонном диапазоне,
а не превращает расходимость долгого неуправляемого полёта в тест аллокатора.
GNU-обёртки учитывают malloc/calloc/realloc/выровненные выделения и C++ new/new[];
положительный контроль обязателен. В непропатченном нативном прогоне upstream
измеренный результат составляет 21,142,500 аллокаций / 1,454,820,000 байт
(CLI возвращает 2); `test-results/validation/jsbsim-native.json` сохраняет хеши
модели/исходников/bridge/checker и окна. XML самолёта не распространяется.

### Отчёт валидации моделей (schema v5)

`node scripts/validate-models.mjs` проверяет `tests/fixtures/validation/reference-manifest.json`
(schemaVersion 2) **до** компиляции, отклоняя пустые/переставленные частоты,
неверные случаи, повторяющиеся ID, отсутствие аналитической баллистики и
некорректные дескрипторы `measurements` или `deferredMeasurements`. Он собирает
настоящие scalar/SIMD-артефакты, запускает два 10-секундных случая движения
твёрдого тела при 400/800/1200 против 4800 Гц, проверяет аналитическую баллистику,
оценивает активные и отложенные эталоны измерений и записывает SHA-256/происхождение
и метрики ошибок в `test-results/validation/model-report.json` (schema v5,
`docs/validation/model-report.schema.json`). Допуск позиции — 0.1 м; ориентации —
0.5 градуса по модулю скалярного произведения кватернионов.

Отчёт содержит `diagnostics.jsbsimBackend`, `diagnostics.jsbsimJsAllocation`,
`diagnostics.annularBem`, `diagnostics.contact`, `diagnostics.jsbsimNative`,
`diagnostics.contactNativePatched` и `diagnostics.jsbsimNativePatched` с путём,
SHA-256 отчёта (или null) и статусом missing/invalid/stale/pass/failed,
проверяемым по текущим хешам исходников и входных данных сборки. Диагностика
описывает доказательства и не допускает полный backend. Numerical PASS (12 случаев)
отделён от fidelity: непройденная достоверность пропеллеров UIUC
(`propellerFidelityStatus: "failed"`), отложенная пользователем достоверность
контакта NASA (`contactFidelityStatus: "blocked"`), отсутствие измеренных
наборов данных планера/ротора (`fidelityStatus: "blocked"`) и неподключённый
полный BET backend сохраняют общий `status: "failed"` с кодом 2. Синтетика не
объявляется измерениями.


## Нативные патчи аллокаций: проверенная область (2026-10-16)

Оба патча включаются явно через `--patched`. Проверочные скрипты проверяют
исходный закреплённый checkout и лицензию, архивируют этот коммит во внешний
кеш, применяют патч репозитория через `git apply --check` и сохраняют SHA-256.
Исходный checkout и npm-артефакт Rapier не меняются. Уравнения, преобразования
единиц, порядок интегрирования и пороги приёмки не изменены. Это повторяемые
нативные эксперименты; production backend не включён.

Патч Rapier сохраняет вектор handles изменённых тел, сбрасывает готовые курсоры
StageSync после завершения работников и повторно использует хранилище переходов
однопоточной narrow phase. Диагностика использует бодрствующую сферу 1 кг и
бесконечное полупространство в NED, 400 Гц, 100,000 шагов прогрева, затем
1,000,000 шагов с 100 тиками подъёмной силы на каждые 800 тиков. Это отличается
от прежней пробы с конечным параллелепипедом и разрешённым сном: напрямую
сопоставлять их счётчики нельзя. Соответствующий текущий исходный прогон даёт
2,002,500 вызовов аллокатора / 96,320,000 байт; патч даёт **ноль вызовов /
ноль байт**. Оба прогона имеют контрольную сумму траектории `317ba7c959cd2b59`.
Нативный f64/std/enhanced-determinism собран без profiler. Это не измерение
npm-привязки f32 WASM и не проверка общего контакта шасси. Эти отдельные
нативные пробы не заменяют рабочие WASM-артефакты `build-contact.mjs` и
`build-jsbsim.mjs --contact`, проверенные в TASK-029 и TASK-031.

Патч JSBSim сдвигает значения внутри пяти существующих слотов истории deque,
обходит существующие дочерние узлы атмосферных overrides без разбора путей
свойств и резервирует списки подачи топлива/окислителя при загрузке модели по
максимальному числу исходных баков двигателя. Динамическое обнаружение overrides,
приоритет топлива, голодание и порядок расходования сохраняются. Закреплённый
эталон c172x проходит полную нативную балансировку и проверки SI/осей. Исходный
счётчик — 21,142,500 вызовов / 1,454,820,000 байт; миллион измеренных шагов
патча даёт **ноль вызовов / ноль байт** в тех же 250 ограниченных окнах полёта.
Контрольная сумма обеих траекторий `164fd3c0bf6d8a39`. Другие самолёты, типы
двигателей, сценарии изменения overrides и контактное сопряжение этим прогоном
не сертифицированы.

Повторять с закреплёнными кешами исходников, GNU C++ 14.2, CMake 3.31.6 и Rust
1.97.0, описанными выше. Исходные прогоны намеренно возвращают 2; прогоны патчей
возвращают 0 лишь при прохождении численных проверок и аллокатора:

```bash
node scripts/check-contact-native.mjs
node scripts/check-contact-native.mjs --patched
node scripts/check-jsbsim-native.mjs
node scripts/check-jsbsim-native.mjs --patched
node scripts/check-engine-patch-parity.mjs
```

Запускать команды независимо, чтобы провал оригинала не пропустил измерение
патча. Проверка паритета требует актуальные хеши пробы/проверяющего кода,
зависимостей, закреплённых исходников и патча, провал исходного аллокатора,
нулевые счётчики патча и совпадение контрольных сумм миллиона шагов. Результат
записывается в `test-results/validation/engine-patch-parity.json`. FNV-1a-64
обрабатывает каждое конечное выходное double в little-endian: 13 компонентов
состояния на шаг Rapier и все 22 компонента моста JSBSim. Совпадение сумм —
детерминированная регрессионная проверка, не криптографическое доказательство
и не измерение физической точности. SHA-256 отдельно фиксирует идентичность
отчётов и исходников. Отчёты `test-results/bench/contact-native-patched.json` и
`test-results/validation/jsbsim-native-patched.json` сохраняют раздельное
происхождение.


## Радио, транспорт автопилота и изолированные отказы (TASK-037–060)

Этот пакет реализует TASK-037/038/039/040/048/052/053/056/057/060. Модули —
независимые протокольные, транспортные и учебные эталоны. Браузерный полётный
Worker по умолчанию по-прежнему использует `DemoDynamics`; браузерный READY
автопилота, записанный Simulation-on-Hardware, живой допуск рельефа в сессию и физическая приёмка
передатчика/полётного контроллера остаются отдельными. Геодезия (TASK-036),
JSON lockstep (TASK-041), потоковая передача HIL (TASK-049), проверка возможностей
HITL (TASK-050), композиция РЭБ (TASK-054/055/058), нативный SITL/РЭБ
(TASK-042/043/059) и браузерный запуск WASM-прошивки (TASK-045) описаны в
разделах ниже.

### Закреплённое подмножество MAVLink2

packages/mavlink/dialect.lock.json закрепляет коммит common XML
2e2b6af99084e4fde9bb304c84bb9253a1a98b6f, хеши common/standard/minimal XML
и лицензии, pymavlink 2.4.50 и файлов генератора. Старый генератор 2.4.49
отклоняет схему закреплённого XML; проверка сохранена с совместимым 2.4.50.
generate-mavlink-fixtures.py проверяет чистоту/коммит/версию и использует
официальный генератор. Полученный Python остаётся вне репозитория; эталонные
кадры зарегистрированы через SHA-256 как синтетические протокольные эталоны,
не измерения самолёта. Уведомление upstream о выводе генератора сохранено
в packages/mavlink/NOTICE.

| Message ID | Message | Full payload bytes | CRC_EXTRA |
| --- | --- | --- | --- |
| 70 | RC_CHANNELS_OVERRIDE | 38 | 124 |
| 93 | HIL_ACTUATOR_CONTROLS | 81 | 47 |
| 107 | HIL_SENSOR | 65 | 108 |
| 113 | HIL_GPS | 39 | 124 |

encodeInto пишет в буфер вызывающего и возвращает точную длину (0 при ошибке).
Усечение конечных нулей MAVLink2 сохраняет хотя бы один байт данных. MavParser
владеет сборочным буфером 280 байт, дополненным нулями payload 255 байт, одним
DataView и таблицей последовательностей на 65536 элементов. Проверяются magic/
версия, флаги, поддерживаемые ID, границы длины и X.25 CRC с CRC_EXTRA. Разбиение
и объединение chunks произвольны; при тайм-ауте неполного кадра вызывается
 discardPartial. После отклонения выполняется ограниченный поиск синхронизации.
Переполнение sequence, пропуски, дубликаты и нарушение порядка учитываются
отдельно; номер последовательности сам по себе не аутентифицирует replay.

Callback синхронно потребляет переиспользуемый кадр. Для хранения нужна копия
на I/O-потоке; повторно входить в parser из callback запрещено. Framing сбрасывается
до callback: исключение потребителя не дублирует кадр. MAVLink1, неизвестные
сообщения, ненулевые compatibility/incompatibility flags и подписанные кадры
отклоняются. Signing не поддерживается и не может незаметно создать доверенную
сессию. Поддержка будущих прошивок явно расширяет это закреплённое подмножество.

SensorMapping реализует раздел 6: u64 — два слова u32, DOP — безразмерный
показатель x100, давление — hPa, магнитное поле — gauss, температура — Celsius.
Ограничение GPS выставляет clipped; известные DOP/скорость насыщаются ниже 65535,
знаковая скорость ограничена +/-32767 см/с. Курс нормализуется до перевода
в градусы и неизвестен ниже 0.05 м/с. Неизвестные признаки дают явные wire-sentinels.
Массивы ImuSample содержат по три компонента; updatedMask допускает биты 0..12
и 31. Неверный вход сохраняет выход. actuatorInto проверяет все 16 нормированных
управлений до изменения выхода. На шаге BigInt не создаётся.

### Преобразование радио и жизненный цикл

Калибровка хранится под ключом mirage.radio-calibration.v1 со schemaVersion=1,
четырьмя проверенными сырыми осями и необязательной независимой осью режима.
По умолчанию режим отключён; включение оси 4 даёт шесть слотов нормированного
ввода. Неверная/отсутствующая включённая ось очищает все стики и arm flag.
Изменения UI немедленно снимают армирование; device-generation защищает
от отключения, повторного подключения и другого передатчика на том же индексе.
Профиль проверяется при загрузке/сохранении; ошибка storage не создаёт валидную
калибровку. Отдельный ручной checklist физической USB-проверки имеет NOT_RUN.

PilotRcMapper использует каналы [roll,pitch,throttle,yaw,mode], по умолчанию
[1,2,3,4,5]. Оси -1/0/1 дают 1000/1500/2000 мкс; газ 0/1 — 1000/2000 мкс.
PWM режимов по умолчанию [1100,1300,1425,1550,1700,1900]; назначение режимов
полёта остаётся в параметрах прошивки. Неизвестный слот оставляет канал ignore.
При отключении освобождаются только собственные каналы, сохраняя чужие.
Каналы 1..8 освобождаются 0; 9..18 — 65534; ignore — 65535. Слоты не выдумывают
requestedMode или enum ArduPilot в mailbox v2.

AutopilotSession задаёт взаимоисключающие external-sitl/wasm-sitl/hitl:
disconnected -> initializing -> warming -> ready -> running, а также fault
и восстановление явным disconnect. Таймеры READY не создают. Требуется свежее
положительное здоровье от автопилота с правильной epoch; для running ещё нужны
актуальные 16 actuator channels. Повторные, будущие и нечисловые отсчёты
отклоняются. Staleness по умолчанию 100 мс, настраивается в (0,1000] мс.
Опрос монотонных часов обнуляет выход при устаревании здоровья/управлений,
провале здоровья, disarm и обращении времени. Класс определяет допуск;
прошивка и декодер реального здоровья этой задачей не предоставлены.

### Двоичный контракт loopback bridge

Мост по умолчанию слушает 127.0.0.1:9002. Точные проверки loopback origin/Host
и 64-hex токен сессии в subprotocol session.<token> защищают upgrade. Токен
не попадает в URL/логи. Согласуемый subprotocol — mirage-v1. Сессией владеет
один клиент; переподключение создаёт новое sequence-состояние для заданной epoch.
Смена epoch требует заново настроенной сессии. Раздельные UDP-порты MAVLink
и physics задаются явно. Мост — транспорт; JSON/servo и lockstep — TASK-041.

Одно двоичное сообщение WebSocket содержит ровно одну запись; фрагменты
WebSocket собирает ws. Объединённые сетевые сообщения остаются раздельными;
конкатенация двух записей в одном сообщении недопустима. Целые заголовка little endian.

| Byte offset | Type | Field | Constraint |
| --- | --- | --- | --- |
| 0 | u8 | version | 1 |
| 1 | u8 | channel | 1=MAVLink, 2=physics outbound, 3=servo inbound |
| 2 | u16 | reserved | 0 |
| 4 | u32 | epoch | configured session epoch |
| 8 | u32 | sequence | monotonic per channel, modulo 2^32 |
| 12 | u32 | payloadLength | 0..4096 |
| 16 | u8[] | payload | exact declared length |

Клиентский вход channel 3 отклоняется. UDP-сокеты подключены к выбранному
loopback peer и не принимают произвольных внешних отправителей. Дубликаты,
устаревшие записи, более 4096 сообщений/с, превышение размера и backpressure
закрывают сессию. Бюджет очереди по умолчанию 65536 байт; бесконечный рост
невозможен. Простой клиента закрывает сессию через 5 с. Тесты используют
настоящие WS/UDP, фрагментацию, отказ origin/токена, переподключение,
epoch/flood/размер и инъекцию backpressure. Старт CLI проверяется отдельно.

Обычный ws — локальный путь разработки. HTTPS-страницам может потребоваться
явный локальный WSS с доверенным сертификатом; сохраняются mixed-content
и PNA/Local Network Access prompts браузера. Настройки безопасности не отключаются.
Тесты не устанавливают работу развёрнутого WSS или сессии SITL.

### Владение Serial-потоком

Connect serial синхронно запрашивает разрешение внутри обработчика кнопки.
При отсутствии API кнопка отключена; отказ показан без автоматического повторения.
SerialTransport владеет одним портом, reader и writer; конкурирующие открытия
отклоняются. Close обрабатывает незавершённые read/open, cancel, ошибки и явное
повторное открытие. Разрешена одна запись до 4096 байт; вызывающий сохраняет
неизменность буфера до завершения. Входные chunks ограничены 4096 байт.
I/O Worker разбирает MAVLink и возвращает копии payload отдельно от physics
Worker. До следующего chunk нужно подтверждение; тайм-аут декодера 500 мс
закрывает транспорт вместо роста очереди. Копии/promises I/O и permission
находятся вне высокочастотного цикла. UI обозначает диагностическое
транспортное соединение и явно оставляет HITL недоступным.

До открытия выбранного порта контроллер ожидает до 5 секунд сообщение
`serial.ready` от инициализированного I/O Worker. Запуск Worker и загрузка
модулей не входят в тайм-аут 500 мс для каждого chunk. При ошибке запуска
порт остаётся закрыт; тайм-аут chunk по-прежнему закрывает установленный
транспорт. Подтверждение готовности не даёт допуска HITL и не меняет
требование жеста пользователя для запроса разрешения.

### Учебные РЭБ и механические отказы

HazardVolumes проверяет <=64 уникальных стабильных ID и сортирует их один раз.
Конечное воздействие сфер/конусов следует разделу 5 с насыщением суммы 1e12,
минимальным радиусом >=1e-6 м, радиусом <=1e6 м, относительной мощностью <=1e6
и опорной дистанцией <=1e6 м. Ось конуса единичная с допуском 1e-9, полуугол
[1e-6,pi/2]. Taper: x=clamp((cosine-cos(theta))/(1-cos(theta)),0,1),
G=x*x*(3-2*x); в центре G=1. Снаружи ноль, включая внешние углы конуса.
Это синтетическая severity, не измеренная RF-мощность/бюджет приёмника.

GnssJamming реализует точный экспоненциальный low-pass и preset раздела 5:
tau>0, Njam=0..3, DOPjam=50..99; dt в (0,0.01] с. Reset/нулевая severity
сохраняют baseline. Зафиксированный no-fix восстанавливается только ниже 0.6
при известном числе спутников >=4; неизвестный счётчик восстановление
не доказывает. Неизвестные признаки остаются неизвестными. Уже худшие DOP/fix/
счётчик не улучшаются. Исходный GPS, IMU, барометр и truth не меняются.

MagneticAnomaly один раз вычисляет Rz*Ry*Rx и biasBodyGauss, затем пишет три
компонента body sensor в готовый буфер. Пересекающиеся source/target views
отклоняются. До bias вращение сохраняет норму; truth quaternion/gyro не входят
во вход и не меняются. Конкретный ответ EKF/траектории/режима не гарантируется.

MotorFaults резервирует ID 0..31 независимо от порядка каналов. Power-cut
масштабирует лишь drive torque, сохраняя аэродинамику и пассивную динамику вала.
Instant-thrust-loss масштабирует силу/аэродинамический момент одного ротора
в том же тике и устанавливает VehicleFlagV2.ModelOutsideValidity (бит 5), пока
такой отказ активен. Reset очищает отказы/флаги. Rust-тесты проверяют спад оборотов
после нулевого привода и плечевой момент снятого ротора. Полная привязка BET/
микшера и полётные тесты компенсации остаются отдельными от этих эталонов.

### Высокочастотный API и граница измерения

Передача/возврат вычисленных float может выделять boxed numbers в V8. Для
высокочастотной композиции использовать приведённые typed-array границы.
Один раз создать массивы длины 3 для позиции/магнитного поля, 1 для severity/
часов/момента, 6 для wrench и 16 для actuators. Часы — монотонные миллисекунды;
исходный GPS и target GPS различны. Ошибочный шаг возвращает false;
конфигурационные конструкторы могут бросать исключения вне шага.

```ts
// Structural hot-path contracts implemented by the corresponding classes.
interface HazardVolumesHot {
  severityFromNedInto(positionNedM: Float64Array, outQ: Float64Array): boolean;
}
interface GnssJammingHot {
  advanceInto(severity: Float64Array, dtS: number): boolean;
  distortInto(source: GpsSample, target: GpsSample): boolean;
}
interface MagneticAnomalyHot {
  distortInto(sourceGauss: Float64Array, targetGauss: Float64Array): boolean;
}
interface MotorFaultsHot {
  driveTorqueFromArrayInto(id: number, sourceNm: Float64Array, outNm: Float64Array): boolean;
  wrenchInto(id: number, source: Float64Array, target: Float64Array): boolean;
}
interface AutopilotSessionHot {
  healthAt(health: AutopilotHealth, clockMs: Float64Array): boolean;
  acceptActuatorsAt(controls: Float64Array, epoch: number,
    sampleMs: Float64Array, clockMs: Float64Array): boolean;
  pollAt(clockMs: Float64Array): boolean;
}
```

node scripts/bench-links-ew.mjs all 400 также принимает 800/1200 и компоненты
ew/mavlink/state. Настоящий граф компонентов использует переменное воздействие,
все четыре типа сообщений, декодер actuators, RC mapping, переполнение слова
времени и проверки здоровья/управлений. Прогрев V8 — четыре миллиона шагов,
затем три пары измеренных окон N=1e6/2e6; выделяющий контроль обязан обнаружиться.
I/O и callbacks профилировщика исключены. Отчёты test-results/bench имеют имена
links-ew-all-<Hz>.json, SHA-256 исходников/скрипта, версию Node, число GC и
добавочные байты/шаг. Это cloud Node, не подтверждение hard real time браузера,
полного допуска Worker/backend или FPS M4/RTX.

### Граница политики рельефа

providerPolicy отклоняет неизвестные конфигурации и замораживает результат.
Google live допускает лишь временную память/TTL 0, offline false, prefetch false;
постоянный R2/prefetch/offline запрещены. Собственные/лицензированные данные
требуют хеши проверенных разрешений. Ключи, загрузка поставщика и физический кеш
не добавляются. См. docs/decisions/terrain-licensing.md и зеркало.


Калибровка режима позволяет менять индекс оси, границы, центр, deadzone и инверсию; изменение снимает армирование, совпадение с основной осью отклоняется.

## Реализованная геодезия: TASK-036

`packages/sensors/src/geodesy.ts` реализует WGS84 (NIMA TR8350.2:
`a=6378137` m, `1/f=298.257223563`) во float64. `geodeticToEcefInto` использует
замкнутую формулу; `ecefToGeodeticInto` — параметрическое начальное
приближение Bowring с тремя уточнениями и
`h=p*cos(lat)+z*sin(lat)-a*sqrt(1-e2*sin²(lat))`, без деления на `cos(lat)`.
`LocalTangentFrame` фиксирует ECEF начала координат и поворот ECEF-to-NED при
создании и переводит смещения NED через ECEF, поэтому полюса и антимеридиан не
требуют особых случаев; долгота сообщается в `[-pi, pi)` и равна 0 на полярной
оси. Все преобразования пишут в `Float64Array` вызывающей стороны без аллокаций.

`packages/sensors/src/geoid.ts` разделяет эллипсоидальную `h` и высоту MSL
`H=h-N`. `GridGeoid` билинейно интерполирует регулярную сетку ундуляций по
широте/долготе (долгота замыкается, широта ограничивается) и требует
происхождение: модель, источник, лицензию и SHA-256. Без неё `NO_GEOID` задаёт
`N=0`, значения MSL предварительные, а `mslAccuracyGate` возвращает
`BLOCKED_EXTERNAL`; несовпадение hash с закреплённым payload также блокирует.
Авторитетной сетки (EGM96/EGM2008) в репозитории пока нет, поэтому абсолютная
точность MSL остаётся заблокированной, а локальные преобразования
NED/ECEF/geodetic проверены.

## Реализованный lockstep ArduPilot JSON: TASK-041

Протокол закреплён на коммите ArduPilot
8ab6afde107a91df1b5f60ade8f333cb8a61b190 (`libraries/SITL/SIM_JSON.{h,cpp}` и
readme примера JSON; SHA-256 в `tests/fixtures/sitl/json-protocol.json`,
исходники не копируются). SITL отправляет servo-пакет в little-endian
`{u16 magic, u16 frame_rate, u32 frame_count, u16 pwm[N]}`: 40 байт с magic
18458 для 16 каналов, 72 байта с magic 29569 для 32 каналов. Его сокет не
привязан, поэтому он отправляет с эфемерного порта на UDP 9002 и ждёт ответ на
этот источник. `frame_count` увеличивается только после корректного ответа;
кадр без ответа отправляется повторно с тем же счётчиком, а перезапущенный SITL
снова начинает с 0.

`ExternalSitlLockstep` (`packages/autopilot/src/external-sitl.ts`) реализует
`StepGate` для режима `sitl-lockstep`. Новый счётчик разрешает ровно один
физический tick; дубликат никогда не выполняет шаг и получает через
`resendReplyInto` идентичные байты; меньший счётчик считается устаревшим, если
он не равен 0 (перезапуск, выставляющий `restartRequested`); пропуск выполняет
один шаг и учитывает потерянные кадры. Пока кадр не ожидается, `ready()` равен
false и policy сразу возвращает управление, поэтому команды вроде pause
остаются отзывчивыми. PWM отображается в тягу через явные `pwmMinUs/pwmMaxUs`
(MOT_PWM_MIN/MAX, по умолчанию 1000/2000) и заданный список каналов моторов с
нумерацией от 1; ограничение значений учитывается.

Ответ — одна строка `"\n{...}\n"` с `timestamp`, `imu.gyro`, `imu.accel_body`,
`position`, `velocity`, нормированным `quaternion` (w x y z) и необязательным
`velocity_wind`. SIM_JSON ищет ключи через `strstr`, поэтому кодер пишет
`velocity` раньше `velocity_wind`; без `velocity` upstream молча прочитал бы
вектор ветра как скорость аппарата. Числа пишутся с девятью фиксированными
знаками после запятой при `|v|<=1e6` в буфер вызывающей стороны без выделения
строк. Timestamp должен увеличиваться меньше чем на 0.1 с, иначе время SITL не
продвинется; такие состояния отклоняются.

`apps/bridge/src/ardupilot-json.ts` привязывает заданный локальный UDP-порт
(`ardupilotJson.localPort`, CLI `MIRAGE_ARDUPILOT_JSON_PORT`), принимает только
loopback-отправителей и корректные servo-пакеты, узнаёт по ним адрес SITL и
пересылает их как канал моста 3. Исходящие строки канала 2 должны быть
печатным ASCII с обрамлением переводами строки, не длиннее 1024 байт, содержать
обязательные поля и ориентацию с конечными значениями и не иметь ключа, текст
которого впервые встречается внутри другого ключа; некорректная строка
закрывает сессию. MAVLink остаётся отдельным каналом. Процесс ArduPilot SITL не
запускается этим транспортным адаптером напрямую; закреплённая нативная обвязка
замкнутого контура описана в TASK-042 ниже.

## Реализованная потоковая передача HIL: TASK-049

`HilClock` (`packages/autopilot/src/hil-clock.ts`) объединяет `SensorScheduler`
с целочисленной фазой на физических часах: HIL_SENSOR с частотой 200 или
400 Гц, HIL_GPS — 5 или 10 Гц, а частоты обновления магнитометра и барометра
делят частоту IMU, поэтому их отсчёты совпадают с сообщениями HIL_SENSOR.
Время отсчёта — время физического tick в микросекундах в виде двух слов
uint32, а не время отправки или настенное время.

`HilStreamer` (`packages/autopilot/src/hitl.ts`) кодирует наступившие отсчёты
через `SensorMapping` и `encodeInto` в ограниченный байтовый буфер исходящих
данных, который опустошает последовательный писатель. `fields_updated` равен
`0x3f` (accel, gyro) в каждом HIL_SENSOR, плюс `0x1c0` (mag) и `0x1e00`
(абсолютное/дифференциальное давление, барометрическая высота, температура)
только в отсчётах, где эти группы обновились. Создание завершается ошибкой,
если кадры худшего случая без усечения (77 байт HIL_SENSOR, 51 байт HIL_GPS)
занимают больше 70% от `baud/10` байт в секунду: IMU 400 Гц плюс GNSS 10 Гц
требуют 31310 B/s, что помещается в 460800 и 921600 бод, но не в 230400 или
115200. Переполнение буфера фиксирует `queue-overflow`. `acceptActuator`
декодирует HIL_ACTUATOR_CONTROLS в собственный буфер, требует все 16 значений
в [-1,1] и строго более новую u64-метку времени автопилота и копирует только
принятые кадры; `poll` фиксирует `actuator-dropout` по истечении заданного
таймаута (по умолчанию 100 мс). Подпись не поддерживается, поэтому канал не
аутентифицирован, а назначение управляющих сигналов моторам остаётся решением
аппаратного профиля (TASK-050).

## Реализованная проверка возможностей HITL: TASK-050

`evaluateHitlCapability` (`packages/autopilot/src/hitl-capabilities.ts`)
возвращает READY, только когда согласуются доказательства из закреплённых
исходников прошивки, проверенный профиль платы и живое наблюдение; матрица и
доказательства находятся в [hitl-matrix.md](hitl-matrix.md). В ArduPilot
8ab6afde107a91df1b5f60ade8f333cb8a61b190 нет обработчиков HIL_SENSOR/HIL_GPS/
HIL_ACTUATOR_CONTROLS, поэтому ArduPilot для этого пути — UNSUPPORTED. В PX4
4d7e4de77742c3ae8187ffc998ed6d04629c611b HIL_SENSOR декодируется только в
режиме HIL, поэтому живая проверка требует `MAV_MODE_FLAG_HIL_ENABLED` (32) в
base_mode HEARTBEAT, git SHA прошивки из профиля и HIL_ACTUATOR_CONTROLS в
течение 100 мс. Любое отсутствие даёт BLOCKED_EXTERNAL с точным требованием.
Вердикты READY заморожены и регистрируются закрыто;
`AutopilotSession.connect("hitl", ...)` теперь требует такой вердикт, поэтому
созданный вручную объект или доступность SITL не включают HITL. Ни одна плата
пока не проверена.

## Стенд ArduPilot: TASK-051 (предложение версии 2)

TASK-051 вынесена из версии 1. Предложение версии 2 — произвести образ
прошивки ArduPilot 4.6.3 или новее с Hybrid SITL и Simulation-on-Hardware,
который можно загрузить на дрон и проверить там. PX4 вне области. Анализатор
и виртуальный прототип JSON ниже сохранены как проектные заметки. Они не
блокируют TASK-082 и не выбирают бэкенд приложения. См. [V2_PLAN.md](V2_PLAN.md).

Правила записанной платы, сохранённые для этой поздней прошивки: `env SIM_ENABLED 1`,
`AHRS_EKF_TYPE` 10, `GPS1_TYPE` 100, `SIM_MAG1_DEVID` 97539 и `SIM_OH_MASK`
в диапазоне 0..65535 при снятых пропеллерах. Плата с `AP_SIM_JSON_ENABLED` —
Hybrid SITL с размещением `board`. Прототип без дрона —
`scripts/run-virtual-hitl.mjs`. См. [hitl-test-procedure.md](hitl-test-procedure.md).

## Реализованная подмена шагом позиции: TASK-054

`PositionStep` (`packages/ew/src/position-step.ts`) планирует смещение NED не
более 10 км на физический tick; `advanceTick` применяет все три оси сразу при
достижении этого tick, а `disable`/`reset` возвращают точную базовую линию.
`GpsOffsetApplier` переносит начало одной переиспользуемой
`LocalTangentFrame` в исходную точку (`setOrigin`, без аллокаций), переводит
высоту MSL в эллипсоидальную через геоид (`h=H+N`), смещает точку на заданную
величину через ECEF и переводит обратно (`H'=h'-N'`). Смещение задано в
касательной плоскости точки, поэтому длинные горизонтальные смещения также
увеличивают эллипсоидальную высоту примерно на `d²/(2R)`; чистое смещение Down
меняет высоту MSL ровно на `-D`. Скорость, время, DOP, fix и курс сохраняются;
нулевое смещение — точное тождество. Исходный отсчёт никогда не изменяется;
некорректный источник оставляет приёмник нетронутым.

## Реализованный когерентный дрейф: TASK-055

`VelocityDrift` (`packages/ew/src/velocity-drift.ts`) интегрирует `b` и `v_d`
по уравнениям раздела 5 на каждом физическом шаге (`dt` в (0, 0.01] с), точно
для постоянного ускорения. Если `|v_d+a dt|` превысил бы `maxSpeedMps`, шаг
делится в корне `|a|²t²+2(v·a)t+|v|²-cap²=0`, интегрируется до этого момента и
продолжается с постоянной скоростью, поэтому `b` остаётся интегралом `v_d`, а
скорость никогда не обрезается задним числом. Восстановление `hold-offset`
замедляет `v_d` с `decelMps2`, продолжая интегрировать `b`, делит шаг в момент
остановки и затем удерживает смещение; `step-to-truth` обнуляет `b` и `v_d` и
увеличивает `discontinuities` для события AAR. На границе 10 км дрейф
останавливается и удерживается. `distortGpsInto` добавляет `b` через
`GpsOffsetApplier` (WGS84 и геоид) и `v_d` к скорости GPS, затем пересчитывает
курс по искажённой горизонтальной скорости (неизвестен ниже 0.05 м/с).
Частота выборки GNSS и рендеринг никогда не меняют состояние дрейфа.

## Реализованная композиция конвейера РЭБ: TASK-058

`EwEngine` (`packages/ew/src/engine.ts`) владеет одним заранее созданным
экземпляром каждого эффекта и реестром отказов на 16 слотов по `faultId`.
`apply(fault.set, tick)` выполняется на границе tick
(`PhysicsSessionV2.applyScheduled` через внедрённый `SessionFaultPort`) без аллокаций. Живой Worker владеет одним `EwEngine` и таблицей `MotorFaults` на четыре мотора. Сессия без этого порта по-прежнему отклоняет `fault.set`. `weather.set` остаётся отклонённой, потому что у demo нет модели ветра. У каждого вида эффекта один
владеющий faultId (для `motor-loss` — на каждый мотор); более новый faultId
заменяет владельца, отключение невладеющего или неизвестного faultId ничего не
меняет, а заполненный реестр возвращает `registry-full`. Отключение дрейфа
использует `recovery` команды; motor-loss передаётся в физический
`MotorFaults` и не затрагивает наблюдения. `reset(seed)` очищает все эффекты,
реестр и отказы моторов. `flags` сообщает биты `ew_flags` ABI состояния.

`advanceInto(context)` продвигает подавление и дрейф на каждом физическом шаге.
`distortGpsInto` составляет: база -> шаг позиции плюс дрейф (суммарное
смещение NED одним преобразованием WGS84, затем скорость дрейфа и курс) ->
подавление (спутники, DOP, fix, применяется на месте). `distortImuInto` меняет
только магнитометр. `SensorPipeline` (`packages/sensors/src/pipeline.ts`)
применяет структурный искажатель, затем квантование через `SensorMapping`,
поэтому порядок — база -> РЭБ -> квантование, а база никогда не изменяется.

V8 упаковывает float-аргументы невстраиваемых вызовов, поэтому высокочастотный
путь передаёт float через typed arrays или поля объектов: геодезия
предоставляет `geodeticToEcefFromInto`, `ecefToGeodeticFromInto`,
`LocalTangentFrame.setOriginFrom/nedToGeodeticFromInto/...`, геоиды —
`undulationFromInto`, `GpsOffsetApplier.applyFromInto` принимает массив
смещения, а дрейф/подавление читают `dtS` из контекста шага (`advanceFrom`).
Скалярные сигнатуры остаются низкочастотными удобными методами.
`MagneticAnomaly.configure` перенастраивает аномалию на месте для команд на
границе tick.


## Контракты теплового конвейера, диагностики и записи (TASK-043/070–078/081)

### Тепловой баланс поверхности (TASK-070)

`HeatSurface` — синтетическая сосредоточенная модель поверхности, обновляемая вне физического цикла 400–1200 Гц и вне шейдеров. `ThermalMaterial` задаёт поверхностную теплоёмкость C_A (Дж/м2/К), поглощение солнечного излучения alpha и излучательную способность epsilon [0,1], конвекцию h и проводимость к подложке k_A (Вт/м2/К). Воздействие содержит температуру воздуха/неба/подложки в К и падающую солнечную мощность Вт/м2. Поглощение и излучательная способность независимы в разных спектральных диапазонах. Классы WorldCover не предоставляют эти коэффициенты или измеренные температуры.

\[
C_A\frac{dT}{dt}=\alpha G-h(T-T_a)-\epsilon\sigma(T^4-T_{sky}^4)-k_A(T-T_b),\quad
\sigma=5.670374419\times10^{-8}\;\mathrm{W\,m^{-2}\,K^{-4}}.
\]

\[
L(T)=\int_{8\,\mu m}^{14\,\mu m}\frac{2hc^2}{\lambda^5[\exp(hc/(\lambda k_B T))-1]}\,d\lambda,
\quad L_o=\tau[\epsilon L(T)+(1-\epsilon)L(T_r)]+(1-\tau)L(T_a),\quad\tau=e^{-\kappa d}.
\]

Неявная схема трапеций решает монотонную скалярную невязку 48 итерациями бисекции в пределах 100..1000 К. Если корень не заключён в интервале, обновление отклоняется без обрезания энергии. dt — (0,60] с, температуры воздействия — 100..1000 К, падающее солнечное излучение — 0..2000 Вт/м2. Множителя температуры от AO нет. Прямое освещение использует солнечный вектор ENU: east=-cos(delta) sin(H), north=cos(phi) sin(delta)-sin(phi) cos(delta) cos(H), up=sin(phi) sin(delta)+cos(phi) cos(delta) cos(H). Прямую нормальную освещённость умножают на max(0,n dot sun) и геометрическую прозрачность тени; ниже горизонта солнечное воздействие равно нулю. Углы в радианах; нормали единичные. Склонение и часовой угол задаёт сценарий, а не настенные часы.

`ThermalField` интегрирует тот же баланс сразу для многих элементов поверхности без выделения памяти шагами Хойна с автоматическими подшагами ниже линеаризованного предела устойчивости. Воздействие задаётся направлением на солнце (ENU) с прямой нормальной и рассеянной горизонтальной освещённостью; у каждого элемента есть единичная нормаль, доля затенения прямого пучка и коэффициент видимости неба V. Длинноволновое излучение неба — eps_sky sigma T_a^4 с излучательной способностью ясного неба по Swinbank 9.2e-6 T_a^2 и облачным множителем Bolz (1 + 0.22 N^2), не более 1; закрытая доля 1 - V излучает при температуре воздуха, поэтому ambient occlusion лишь взвешивает явное излучение. Конвекция h = 5.7 + 3.8 v (McAdams). `solarPosition` вычисляет положение солнца по UTC и широте/долготе рядами NOAA/Meeus (сверено с NREL SPA в пределах 0.05 градуса); `clearSkyIrradiance` использует атмосферную массу Kasten-Young, DNI по Meinel = S0' 0.7^(AM^0.678) с S0 = 1361 Вт/м2 и эксцентриситетом Spencer, рассеянную = 0.1 DNI и облачный множитель Kasten-Czeplak 1 - 0.75 N^3.4. Тесты перекрёстно сравнивают ThermalField с HeatSurface и solarIncidence с эфемеридами. Типичные свойства поверхностей — некалиброванные синтетические значения.

### Синтетический LWIR-рендеринг (TASK-071)

`InstrumentProfile` содержит ID, собственное разрешение (16..4096 по каждой оси), спектральную полосу в микрометрах (плоский отклик внутри полосы), NETD в кельвинах и источник калибровки — синтетический (с примечанием) или измеренный (название прибора и SHA-256 калибровочных данных). `claimsParityWith` истинно только для измеренного профиля этого прибора; поставляемый профиль `synthetic-lwir-640` (640x512, 8-14 мкм, NETD 0.05 К) не заявляет соответствия CADEX или иному прибору. `ThermalScene` содержит температуры отражения и воздуха (пути), коэффициент ослабления на метр и диапазон отображения.

CPU интегрирует яркость Планка по полосе составной формулой Симпсона (512 интервалов, точные константы СИ h/c/k_B) в таблицу float32 с шагом 1 К на 150..405 К; яркость — Вт/(м2 ср). Таблица однократно загружается как текстура. `shaders/thermal.glsl` (GLSL ES 3.00) читает float G-буфер (температура поверхности в К, излучательная способность, дальность в метрах), интерполирует таблицу, применяет излучение, отражение и ослабление Бугера—Ламберта, линейно отображает яркость между яркостями границ диапазона в ограниченный уровень и применяет палитру white-hot, black-hot или ironbow; необязательный шум NETD использует целочисленный хеш координат пикселя и seed кадра. `ThermalCameraPass` выводит изображение в цель с собственным разрешением профиля; покадровых CPU-циклов по пикселям нет. `apparentRadiance`/`apparentLevel`/`paletteColor` — зеркало на CPU в float64 для тестов, и браузерный тест попиксельно сравнивает с ним шейдер. Интеграция рабочей тепловой сцены, WebGPU-проход, равенство пикселей разных GPU и FPS целевых устройств не заявляются.

### Шторка и NUC (TASK-072)

`ThermalNuc` владеет фиксированными массивами выходов, смещений и накопления. Конфигурация задаёт pixels, frameHz, intervalFrames (между началами циклов), closedFrames, calibrationFrames и openFrames. ID кадров — последовательные безопасные целые; обратные/пропущенные/некорректные кадры отклоняются без изменения статуса. Запрос начинает цикл на следующем кадре датчика. Перерыв изображения длится ровно сумму трёх фаз. Во время калибровки mean(raw-referenceK) оценивает аддитивное смещение каждого пикселя; после завершения коррекция равна raw-bias. В idle выход обновляется; остальные фазы удерживают предыдущее изображение, а временные метки продолжают расти как frameId/frameHz. Физика и записанная истина не передаются на вход. Это синтетическая коррекция смещения; дрейф усиления и измеренная радиометрия шторки вне профиля.

### Диагностика автопилота и прогрев (TASK-043)

`EkfMonitor` принимает прошедшие CRC-проверку MAVLink2 HEARTBEAT (ID 0, CRC_EXTRA 50, длина 9) и ArduPilot EKF_STATUS_REPORT (ID 193, CRC_EXTRA 71, длина 26 с необязательной дисперсией воздушной скорости). Эталон независимо сгенерирован из ardupilotmega XML существующей закреплённой ревизии MAVLink с pymavlink 2.4.50; сохранены рекурсивные хеши XML и модуля генератора. В HEARTBEAT custom_mode — u32 со смещения 0, autopilot в байте 5 должен быть 3, mavlink_version в байте 8 — 3. Пять отношений EKF — f32 по смещениям 0/4/8/12/16; flags — u16 по смещению 20; расширение airspeed начинается с 22. Консервативный учебный допуск требует конечных неотрицательных отношений меньше 1 и отклоняет EKF_UNINITIALIZED (1024). Исходные биты 1/2/4/16/32 переходят в ABI-v2 1/2/4/8/16. Относительная горизонтальная позиция не заменяет абсолютную. Принимается только настроенная пара system/component. TASK-074 копирует принятые кадры system/component 1/1 из браузерного serial-декодера в заранее выделенный `MavFrame` и накладывает снимок `EkfMonitor` на `FlightStateV2` потока Main, который читает `PilotHud`. Публикация Worker физики оставляет `AutopilotStatusValid` сброшенным. Разрешение USB Serial, окно свежести 1000 мс или показанные флаги EKF не допускают браузерный READY, HITL или `EkfWarmup`.

Временная область — миллисекунды симуляции SITL или монотонные настенные миллисекунды HITL. Возраст heartbeat и EKF не превышает 1000 мс, будущие метки запрещены. `EkfWarmup` дополнительно требует 30 секунд симуляции, совпадения эпох, отсутствия обратного хода часов, возраста IMU <=0.01 с и GNSS <=0.3 с без будущих отсчётов. Выдаётся фактически измеренное отношение времени симуляции к настенному; настройка speed сама не ускоряет прошивку. HITL запрещает speed !=1 и опережение симуляцией настенного времени более чем на 1% плюс 0.1 с. РЭБ запрещена до прохождения допуска и снова запрещается при отказе здоровья.

`LiveEkfWarmup` соединяет существующие CRC-валидирующий `MavParser`, привязанный к идентичности `EkfMonitor` и `EkfWarmup` в Linux-драйвере. По умолчанию используются часы сенсора MAVLink, дополнительно — явные подтверждения IMU json-lockstep external-SITL. Сообщения датчиков GPS_RAW_INT (24, CRC 24, length 52), RAW_IMU (27, CRC 144, length 29) и HIGHRES_IMU (105, CRC 93, length 63) имеют независимые проводные эталоны pymavlink 2.4.50, зарегистрированные с хешами источника/генератора. Микросекунды загрузки преобразуются из u64 безопасным числом; GPS требует 3D fix. Допускаются только system/component 1/1 и основной IMU. Конструкторы имеют явные поля, чтобы холодный Linux-инструмент Node 24 загружал те же модули.

Нативный поток сенсора — JSON-ответ 800 Hz, а не прибытие MAVLink-отчёта. `acknowledgeJsonImu(servoFrame, repliedFrame, sampleTimeS)` требует N/N-1, последовательных кадров, возрастающего настоящего закодированного времени отсчёта и шага не более 0.01 s. Драйвер передаёт время предыдущего ответа только после следующего корректного servo-пакета, подтверждающего потребление. Плохое подтверждение делает сенсор неприменимым. HITL не может выбрать этот источник. Часы IMU-отчёта firmware остаются отдельной диагностикой: частота пакетов/эпоха сериализации не подгоняются и не заменяют часы отсчёта. GPS использует закреплённый `AP_GPS` `last_fix_time_ms` из CRC-проверенного GPS_RAW_INT. Пороги свежести неизменны: IMU <=0.01 s, GNSS <=0.3 s, heartbeat/EKF <=1 s, без будущих меток, 30 модельных секунд, совпадающая эпоха и здоровые конечные инновации <1.

Sidecar записывает исходные проводные байты с каждым декодированным наблюдением и запрашивает HIGHRES_IMU каждые 3 ms, GPS_RAW_INT каждые 50 ms. При закреплённом планировщике 400 Hz запрос 2500 us усекается до 2 ms и отклоняется `cap_message_interval`; 3 ms принимается. Это исправление конфигурации потока, а не ослабление допуска. Драйвер оценивает готовность на тиках физики и пишет `warmup.ndjson` на 100 Hz плюс каждом переходе: часы источников, точное реальное время, нормализованное здоровье, флаги READY/РЭБ, причину и измеренное ускорение. Неизвестный возраст диагностики до первого отчёта сериализуется как null и не проходит.

`scripts/check-ekf-warmup.mjs` воспроизводит все исходные подтверждения физики и телеметрию с независимой проверкой сырого CRC через те же модули, проверяя каждое записанное решение. Событие потока во время физики t следует за завершённым тиком; replay подаёт только события `receivedSimS<t` перед оценкой следующего тика. Настоящие допуск/отзывы отделены от явно синтетических проверок проваленной инновации, устаревшей диагностики, плохого подтверждения, потери GNSS, обратного времени, disposal и HITL fast-forward. Отчёт: `test-results/validation/task-043-warmup.json`. Наблюдавшийся прогон допускает в 41.27625 модельных секунд и 20.733261598 реальных секунд (1.990822804x); два настоящих превышения свежести GNSS свыше 0.3 s отзывают READY/РЭБ и восстанавливаются со свежими данными, а полный полёт проходит неизменный диапазон TASK-042. Браузерный READY, записанный Simulation-on-Hardware и аэродинамическая достоверность TASK-033 остаются отдельными.

### Формат AAR и владение (TASK-076)

```typescript
interface AarManifest {
  formatVersion: 1;
  recordBytes: 512;
  modelSha256: string;
  firmwareSha256: string | null;
  seed: number;
  physicsHz: 400 | 800 | 1200;
  recordHz: number;
  durationS: number;
  clock: "simulation";
  source: "demo-decimated" | "producer";
}
interface ArchiveLoss {
  queueLost: number;
  evicted: number;
  storageDropped: number;
}
```

Парсер отклоняет неизвестные поля, неверные хеши, seed/частоты, длительность свыше 1800 с и вычисленное кольцо сверх бюджета архива 32 МиБ минус 8192 байт. По умолчанию 10 Гц x 1800 с x 512 байт = 9,216,000 байт кольца. Отдельный SAB 131,136 байт используется только для записи, не как второй потребитель очередей полётных датчиков/актуаторов. Заголовок: байт 0 magic 0x4d415251, 4 версия 1, 8 счётчик записи, 12 счётчик чтения, 16 счётчик переполнений/потерь; байты 20..63 зарезервированы нулевыми. Ёмкость 256 записей по 512 байт. Все общие int32 доступны через Atomics. Производитель копирует полную локальную запись и публикует модульный счётчик записи; потребитель копирует до освобождения слота. Полная очередь отбрасывает новые данные, увеличивая счётчик без блокировки физики. Создание/привязка вне шага.

| Байтовое смещение | Тип | Поле / единицы |
| ---: | --- | --- |
| 0 | u32 | magic 0x4d415252 |
| 4 | u32 | версия записи 1 |
| 8 | u32 | шаг 512 байт |
| 12 | u32 | эпоха сеанса |
| 16 | u32[2] | tick lo/hi |
| 24 | f64 | секунды симуляции |
| 32 | f32[4] | roll, pitch, yaw [-1,1], throttle [0,1] |
| 48 | u32 | flags: truth=1, pilot=2, sensor=4, actuator=8, event=16, decimated=32 |
| 52 | u32 | числовой ID события; 0 — события нет |
| 56 | u32 | пропущенные записываемые отсчёты после предыдущего принятого |
| 60 | u32 | CRC-32/ISO-HDLC, кроме байтов 60..63 |
| 64 | bytes[192] | StateCodecV2; нулевые слова seqlock/reserved |
| 256 | bytes[128] | SensorFrameCodecV2 или нули при отсутствии |
| 384 | bytes[128] | ActuatorFrameCodecV2 или нули при отсутствии |

Вложенные данные сохраняют единицы и системы координат ABI-v2. Отсутствующие данные нулевые, бит присутствия сброшен; декодеры отклоняют несовпадение эпох/заголовка/времени/тика, неконечные значения, зарезервированные биты и неверный CRC. Код события 0 означает отсутствие; ненулевые требуют бита события и интерпретируются реестром сценария. Текст и секреты в запись не входят.

Worker записи забирает не более 256 записей за опрос каждые 10 мс в предварительно выделенное хронологическое кольцо и чанки по 64 записи (32768 байт). IndexedDB использует фиксированное кольцо из ceil(ringBytes/32768) ключей и одну активную транзакцию; чанки, записанные во время её выполнения, ждут в ограниченном списке ожидания (по умолчанию 8) и записываются по порядку. Переполнение этого списка, слишком большие чанки и неудачные транзакции учитываются точными байтами/записями; вытеснение кольца, повреждённые записи и потери производителя раздельны. Ошибка квоты/хранилища оставляет явно обозначенное кольцо в памяти. Базы сеансов имеют уникального владельца и удаляются при штатном закрытии; host запрашивает завершение и принудительно останавливает Worker по ограниченному таймеру. Сбой браузера может оставить базу сеанса; каталог восстановления и продолжение после перезагрузки не заявляются. Снимки копируются вне физического цикла в пределах бюджета и имеют таймаут.

Приложение записывает каждый тик физики из Worker физики в очередь записи. Запись содержит истину и вход пилота, использованный на этом тике. Полезные нагрузки датчика и актуатора копируются только из кадров, которыми тик уже владеет; пока идёт запись, сессия — единственный потребитель очереди датчиков и не подключает второго потребителя к полётной очереди. Полная очередь отбрасывает новую запись и считает потерю. Источник манифеста — `producer`, а `recordHz` равен частоте физики. Длительность ограничена так, чтобы `recordHz * durationS * 512` оставалось в бюджете архива 32 МиБ минус 8192 байт, что короче 30 минут на 400/800/1200 Гц. Графики по-прежнему прореживают ряд до 10000 точек. Хеш demo-модели — SHA-256 исходника динамики; хеш прошивки null.

### Воспроизведение, графики и архивы (TASK-077/078/081)

Воспроизведение снимков проверяет все записи и держит собственную копию, отклоняет повторный сегмент эпохи, уменьшающиеся тики и обратное время; поиск выбирает снимок не позже заданного времени в одной эпохе. Интерполяции через сброс/пропуски нет. Ресимуляция — отдельный внедряемый backend: хеши модели/прошивки и seed совпадают, reset разрешает конфигурацию. Евклидова ошибка позиции и угловая ошибка кватерниона с эквивалентностью q/-q формируют PASS/FAIL с максимумами/числом сравнений и заранее заданными допусками. Отсутствие provenance, пустой прогон и расхождения не переписывают записи; рабочего ресимулятора по умолчанию нет.

Графики используют общие секунды симуляции и явно выбранную эпоху. Показываются pilot roll, канал актуатора 1 и body roll-rate рад/с; неизвестный актуатор разрывает кривую. Счётчик пропущенных отсчётов, смена эпохи и интервал больше 1.5/recordHz разрывают сегмент. Вывод ограничен 10000 точками: границы и экстремумы пилота/отклика на корзину; корзины с пропущенным разрывом консервативно разрывают прореженные сегменты. Синтетический 30-минутный тест проверяет задержку ступенчатого отклика, узкий импульс — прореживание. Графики не меняют живой полёт.

Архивы несжаты, максимум 32 МиБ. Заголовок 64 байта: u32 magic 0x4d415241 по смещению 0, версия 1 по 4, длина метаданных по 8 (<=4096), число записей по 12, байты данных по 16 (=count*512), потери производителя по 20, вытеснение по 24, потери хранилища по 28, 32 байта SHA-256 по 32. UTF-8 JSON манифеста начинается с 64, сразу за ним записи. SHA-256 покрывает весь архив с нулями в байтах 32..63. Импорт проверяет размер/версию/умножение длин до ограниченных копий, затем хеш, белый список манифеста и все записи. Без сжатия нет бомб декомпрессии. Произвольные метаданные, API-ключи/токены и серийные идентификаторы безусловно исключены. Экспорт/просмотр показывают размер, категории источников и счётчики. Импортированные снимки отделены от активной модели.

Область коэффициентов тепловой модели: поверхностная теплоёмкость 1..1e9 Дж/м2/К; конвекция и проводимость к подложке 0..1e5 Вт/м2/К. Ограничения исключают конфигурации с переполнением/потерей значимости до интеграции.

Усиление регрессий: PhysicsSessionV2 считывает настенное время приёма после согласованного чтения стиков, чтобы параллельная валидная публикация не выглядела будущей; настоящие будущие/устаревшие входы по-прежнему разоружают. Функциональная проверка WebGPU едина на документ, включая активный запрос; перезагрузка повторяет её после смены драйвера. Тесты рендерера используют изолированный стенд и сравнивают диагностику в одном документе. Моторный отказ инструктора выбирает индекс канала, отключение питания либо синтетическую мгновенную потерю тяги и остаточную долю; команды смены эпохи ждут соответствующий ACK, даже если общий заголовок обновился раньше.

Несколько записей датчиков/событий могут иметь один физический тик и одинаковое время симуляции; воспроизведение сохраняет порядок приёма. Backend ресимуляции продвигается до запрошенного тика, а не выполняет новый шаг на каждую запись наблюдения.

Удаление метаданных при экспорте настраивается: по умолчанию неизвестные поля отклоняются; omit-extra-metadata копирует только объявленные поля манифеста и удаляет остальные значения, включая API-ключи и серийные идентификаторы. Ни один режим не сохраняет секреты. Импорт остаётся строго ограниченным белым списком.

```typescript
type ArchiveRedactionPolicy = "reject-extra-metadata" | "omit-extra-metadata";
export declare function exportArchive(
  manifest: unknown,
  records: Uint8Array,
  loss?: ArchiveLoss,
  redaction?: ArchiveRedactionPolicy,
): Promise<Uint8Array<ArrayBuffer>>;
```

## Сравнение с измеренными сбросами NASA TM X-3561 (TASK-029/033)

Три извлечения Docling из отчётов NASA/NACA по шасси архивированы побайтово
(окончания строк CRLF) в `tests/fixtures/contact/nasa/`. `.gitattributes`
помечает их как `binary`. `scripts/check-docs.mjs` считает Markdown внутри
`tests/fixtures/` сырыми данными фикстур, поэтому документационная пара не
требуется. Проверка на кириллицу по-прежнему применяется.

| Архив | Отчёт | NTRS id | SHA-256 | Используется |
| --- | --- | --- | --- | --- |
| `nasa-tm-x-3561.md` | NASA TM X-3561, Fasanella, McGehee, Pappas, Langley, ноябрь 1977 | 19780003109 | `8cf5d33d1d2afbd4a28af064901fcf82910dad25e9e3ce916b2249e5d12c4c39` | Да: вертикальные сбросы на горизонтальную поверхность |
| `nasa-tp-2353.md` | NASA TP-2353, McGehee, сентябрь 1984 | 19840024308 | `1a2a73a922c4b76b174968a554e7390c5e5d717322965ff959c056655b6b3aad` | Нет: результаты сбросов есть только в изображениях рисунков |
| `naca-report-1248.md` | NACA Report 1248, Milwitzky, Lindquist, Potter, 1955 | 19930092250 | `e49485f4d8a44c151f09b39fff8c67fbb2fbf8441fb5aa19566ec5c1594630ba` | Нет: раскрутка колеса с поступательной скоростью на стойке под 15 градусов; значения отдельных испытаний только на рисунках |

Каждая ссылка имеет вид `https://ntrs.nasa.gov/citations/<NTRS id>`. NTRS id для
TM X-3561 взят из имени переданного файла, потому что в тексте Docling его нет.

`python3 -I tests/fixtures/contact/generate_nasa_drop.py` (только стандартная
библиотека) работает в пять шагов:

1. Проверяет хеши всех трёх архивов.
2. Нормализует CRLF для разбора.
3. Требует, чтобы каждое цитируемое предложение или строка таблицы совпадали
   ровно один раз.
4. Переводит значения в американских единицах в SI. Отчёт указывает, что
   измерения велись в этих единицах; его собственное округлённое значение SI
   сохраняется как перекрёстная проверка `printedSi`.
5. Записывает `tests/fixtures/contact/nasa-drop.json` (12 834 байта, SHA-256
   `62adb81b0a56b5e50a921db0e26d154501b0e4e83a58cfc2f22fed571bc69207`).

`--check` завершается ошибкой, если файл устарел; `tests/fixtures.test.ts`
запускает эту проверку. Рисунки не оцифровываются, ничего не интерполируется
и не экстраполируется. Генератор также сверяет цитируемую высоту свободного
падения 6,7 in со скоростью удара 6 ft/s.

Коэффициенты перевода точные: ft = 0.3048 m, in = 0.0254 m,
lbm = 0.45359237 kg, lbf = 4.4482216152605 N, psi = lbf/in^2 и
g = 9.80665 m/s^2.

| Величина | Значение в источнике | Значение SI | SI в отчёте |
| --- | --- | --- | --- |
| Сбрасываемая масса (масса, действующая на стойку) | 3280 lbm | 1487.7829736 kg | 1490 kg |
| Масса узла колеса (колесо, шина, поршень) | 55.7 lbm | 25.265095009 kg | 25.3 kg |
| Сила смятия сот (имитация подъёмной силы) | около 3600 lbf | 16013.5978149 N | 16.00 kN |
| Диаметр / радиус ненагруженной шины | 1.81 ft | радиус 0.275844 m | диаметр 0.552 m |
| Ширина шины | 0.5735 ft | 0.1748028 m | 0.175 m |
| Давление в шине, избыточное | 60 psig | 413685.43759 Pa | 414 kPa |
| Давление зарядки амортизатора, избыточное | 278 ± 10 psig | 1916742.5275 ± 68947.6 Pa | 1917 ± 69 kPa |
| Максимальный ход амортизатора | 0.75 ft | 0.2286 m | 0.229 m |
| Скорость удара (снижения), по три сброса | 4 / 5 / 6 ft/s | 1.2192 / 1.524 / 1.8288 m/s | 1.2 / 1.5 / 1.8 m/s |
| Максимальный ход амортизатора, горизонтальная поверхность | 2.2 / 3.7 / 4.4 in | 0.05588 / 0.09398 / 0.11176 m | 5.6 / 9.4 / 11.2 cm |
| Граница ускорения верхней массы (все горизонтальные случаи) | не превышает -1.6 g | >= -15.69064 m/s^2 | -1.6 g |
| Время отскока от сот, 4 ft/s | 0.15 s | 0.15 s | 0.15 s |

Ускорения в источнике положительны вниз, поэтому они напрямую соответствуют
оси NED «вниз». Значение -1.6 g — максимум для 6 ft/s, и оно ограничивает все
три случая. Ход для 5 ft/s взят из опорных сбросов на горизонтальную
поверхность в серии с наклонными поверхностями. Сигналы акселерометров
фильтровались с плоской АЧХ до 100 Hz; порядок фильтра в отчёте не указан.

### Регистрация и адаптер

`tests/fixtures/registry.json` регистрирует `contact/nasa-drop.json` как
`nasa-tm-x-3561-drop-v1` с `formatVersion` 1 и указанными выше единицами SI.
Конечная область применимости покрывает измеренный диапазон. Допуск —
`{absolute: 0.002, relative: 0.1}`, объявленный по источнику до оценки:

* абсолютное значение — проникновение в метрах, вдвое больше допустимой
  линейной ошибки Rapier по умолчанию;
* относительное значение — 10 процентов на измеренных границах.

Происхождение измеренное, без derivation:

```json
{"kind":"measured","datasetId":"NASA-TM-X-3561-DropTest","license":"Public-Domain-US-Gov","acquiredAt":"1977-11-01T00:00:00Z","referenceUrl":"https://ntrs.nasa.gov/citations/19780003109"}
```

Измеренное происхождение теперь использует `referenceUrl` (HTTPS) вместо
прежнего ключа `reference`, который не использовала ни одна измеренная
фикстура. `acquiredAt` — дата отчёта, так как даты испытаний не указаны.

`packages/physics/src/nasa-drop.ts` проверяет полезную нагрузку и её единицы,
затем запускает реальный `GroundContact` (Rapier 0.21.0) на 400/800/1200 Hz по
0.3 s на случай:

* сосредоточенная сбрасываемая масса — сфера радиуса ненагруженной шины,
  касающаяся плоскости при t = 0 с измеренной скоростью снижения;
* сила сот действует вверх во время снижения (в отчёте: она «включена» при
  смятии и падает до нуля при отскоке);
* коэффициент восстановления равен 0.

Проверки:

* **Импульс:** сообщаемые импульсы контакта уравновешивают m·Δv за вычетом
  собственных сил тяжести и подъёмной силы обвязки с точностью 1 процент от
  m·v0. Импульс сжатия гасит m·v0 с точностью 10 процентов. Это проверка
  согласованности решателя, а не сравнение с измерениями.
* **Непроникание:** максимальное проникновение не больше 0.002 m.
* **Энергия:** после остановки скорость отскока не больше (e + 0.01)·v0.
* **Граница замедления:** и наиболее отрицательное ускорение за шаг, и его
  скользящее среднее за 10 ms (соответствует полосе 100 Hz прибора) остаются
  не ниже -1.6 g × 1.1.
* **Граница хода:** ход контакта модели в пределах 10 процентов от измеренного
  хода амортизатора.

### Результат (2026-10-16)

| Случай | Измерено | Пик за шаг, 400/800/1200 Hz | Окно 10 ms | Ход контакта | Измеренный ход |
| --- | --- | --- | --- | --- | --- |
| level-4fps | >= -1.6 g | -49.8 / -99.5 / -149.3 g | -12.43 g | 0.11 / 0.09 / 0.07 mm | 55.9 mm |
| level-5fps | >= -1.6 g | -62.2 / -124.4 / -186.6 g | -15.54 g | 0.14 / 0.11 / 0.09 mm | 94.0 mm |
| level-6fps | >= -1.6 g | -74.7 / -149.3 / -223.9 g | -18.65 g | 0.16 / 0.13 / 0.11 mm | 111.8 mm |

Проверки импульса, непроникания и энергии проходят во всех девяти прогонах.
Например, импульс остановки 2720.4 N·s на 400 Hz против m·v0 = 2720.9 N·s, а
ошибка баланса меньше 1e-4 N·s.

Обе измеренные границы **не выполняются** ни в одном прогоне. Жёсткая сфера
гасит снижение за несколько шагов, поэтому её пик растёт с частотой шага, и у
неё нет степени свободы шины или амортизатора. Поэтому шлюз точности контакта
NASA — FAIL, а не PASS. Для прохождения нужна модель шасси с характеристикой
сила–деформация шины и масляно-пневматическим амортизатором, проверенная без
подгонки под эти же границы.

Фикстура и архив описывают стойку (площади отверстия и поршня, объёмы,
давление зарядки). Однако уравнение шины и соотношения расхода через отверстие
в тексте Docling помечены `formula-not-decoded`, поэтому здесь они не
выдумываются.

По решению пользователя об объёме работ от 2026-10-18 измеренная достоверность
сбросов NASA явно отложена (`deferredMeasurements` в
`tests/fixtures/validation/reference-manifest.json`, schemaVersion 2), а
историческое неудачное сравнение сохранено в
`test-results/validation/nasa-drop-legacy.json` (`kind: "archived-failure"`).
`node scripts/validate-models.mjs` (отчёт schema v5) проверяет хеши отложенного
дескриптора, архива и зарегистрированной фикстуры `tests/fixtures/contact/nasa-drop.json`,
записывает `deferredMeasurements[]` с ID, причиной, путём/хешем архива и
историческим статусом `failed`, и выставляет `contactFidelityStatus: "blocked"`
(никогда `pass` без активного прошедшего измерения контакта),
`numericalStatus: "pass"` (12 случаев), `propellerFidelityStatus: "failed"`,
`fidelityStatus: "blocked"` и общий `status: "failed"` (код 2).

## Инструменты приёмки, collision-чанки и сценарии

Этот раздел задаёт контракты инструментов приёмки, collision-решётки, исполнения сценариев и доступности для TASK-042/044/051/059/065/073/079/080/082/083. Нативный замкнутый контур SITL (TASK-042/043/059), браузерный запуск ArduPilot WASM (TASK-045) и связь контакта Rapier с плоскостями рельефа (TASK-065) реализованы; браузерный READY автопилота, записанный Simulation-on-Hardware, измеренная аэродинамика, подключение живого рельефа к полётной сессии и полный тепловой рендеринг остаются отдельными.

### Форматы свидетельств и вердикты

Общие функции ограничивают вход 32 MiB, проверяют точный SHA-256, отклоняют некорректные/нечисловые поля и пишут отчёты версии 1 в test-results/validation. PASS даёт 0, FAIL — 1, BLOCKED_EXTERNAL — 2. Отсутствие входа не превращается в зелёный тест. Аппаратные/source-строки импортированного JSON — декларации для проверки оператором, а не криптографическое доказательство физического исполнения. Структурные тесты явно синтетические и не допускают аппаратные/прошивочные режимы. CLI сохраняет sourceRevision, validatorSha256 и, при наличии, inputSha256; исходные захваты нужны для аудита.

SITL фиксирует коммит прошивки 8ab6afde107a91df1b5f60ade8f333cb8a61b190, EKF3 и arming checks. Собственный Linux-драйвер `scripts/sitl/driver.mjs` (с закреплённым sidecar pymavlink 2.4.50 `scripts/sitl/telemetry.py`) управляет проверенным нативным ELF ArduCopter совместно с `BetRigidBodyBackend`. Анализатор требует непрерывный servoFrame от нуля, четыре PWM 1000–2000 us, возрастающее время с разрывами<=0.1 с, реальное происхождение/модель/прошивку и здоровый EKF. Стадии идут arm→takeoff→hold→land, в GUIDED=4 до LAND=9. Высота взлёта>=3 м, удержание 10 м ±1 м не менее 10 с, последний отсчёт разармирован ниже 0.5 м. Закрытый запуск ограничен 120 с/16 MiB; завершается только собственный процесс/группа. Закреплённые исходники/хеши сами не доказывают воспроизводимость бинарника. Полночастотная проверка захвата (`scripts/check-sitl-capture.mjs --input CAPTURE_DIRECTORY`) и трасса v2 описаны в разделе нативного замкнутого контура TASK-042 ниже.

TASK-051 — предложение версии 2 и не является гейтом приёмки версии 1. Её анализатор, сохранённый для этой поздней прошивки, охватывает 60–3600 с. Виртуальный Hybrid SITL использует источник происхождения `virtual-sitl`, для copter `SIM_RATE_HZ` не ниже 400 и p99 задержки вычисления <=2.5 мс, без дрона и без последовательного порта. Записанный Simulation-on-Hardware требует ArduPilot >=4.6.3, `AHRS_EKF_TYPE` 10, `GPS1_TYPE` 100, `SIM_MAG1_DEVID` 97539, промежутки heartbeat <=2.5 с и отключение, после которого канал пропадает и актуаторы выключаются. Hybrid SITL для plane, rover и blimp использует `SIM_RATE_HZ` не ниже 50 и p99 опоздания <=5 мс. См. процедуру версии 2; CLI не открывает последовательный порт и не армирует аппарат.

РЭБ требует контроль без отказа и случаи jamming, position-step, velocity-drift, magnetic, motor-loss. Нативный сбор TASK-059 использует scripts/run-ew-sitl.mjs, существующий драйвер TASK-042 и EwEngine из TASK-058. GPS1_TYPE=14 принимает настоящие GPS_INPUT с частотой 10 Гц; GPS2_TYPE=0 исключает маскировку искажённого приёмника чистым резервом. Положение/скорость в JSON физики остаются истинными. Шаг 30 м на север, северный дрейф 0.5 м/с² с пределом 4 м/с и подавление severity=1 меняют только GPS. Магнитное смещение добавляет [0.3,0.2,0] Гаусс в FRD через все три SIM_MAGn_OFS (отрицательные миллигауссы, поскольку SIM_Compass вычитает offsets); ориентация и силы IMU не искажаются. Мотор 0 теряет всю силу и момент рыскания после запаздывания мотора через явный синтетический контракт instant-thrust-loss, а не электрическую модель двигателя.

План закрепляется до калибровки: seed 59, физика 800 Гц, запись ответа 100 Гц, допуск по живому READY, 5 с устойчивого висения перед воздействием, 12 с воздействия и 8 с восстановления; полная потеря мотора ограничена 3 с без заявления о восстановлении. Отключение дрейфа использует step-to-truth. Прогоны отказов сохраняют нездоровые флаги EKF, отношения инноваций, режимы и траекторию вместо требования здоровой посадки TASK-042. Нативный исходник 8ab6afde перенёс ARMING_CHECK в ARMING_SKIPCHK: настоящий полный ответ параметров должен показать ARMING_SKIPCHK=0, EK3_ENABLE=1 и AHRS_EKF_TYPE=3. Старый parameters.parm остаётся историческим; проверки не обходятся.

Манифесты схемы 2 задают шесть упорядоченных каталогов записей. scripts/sitl/check-ew.py независимо декодирует оба исходных потока через pymavlink 2.4.50 с проверкой CRC, сопоставляет каждый отправленный GPS_INPUT с исходным наблюдением и квантованием, проверяет ответы GPS прошивки и полный снимок параметров до отказа. scripts/sitl/audit-ew.mjs заново запускает этот декодер, воспроизводит каждый настоящий PWM через исходный WASM твёрдого тела и каноническое расписание отказа, сравнивает истину и кватернион, восстанавливает каждое базовое/искажённое наблюдение, проверяет подтверждения магнитного воздействия/восстановления и связывает строки ответа с исходными heartbeat/EKF/global-position со свежестью <=1 с. Хеши истины сравнивают состояние до/после обработки наблюдения в одном tick. Отдельные замкнутые полёты могут иметь разные траектории; отказ мотора намеренно меняет физическую истину. Прежние самодекларированные флаги изменения наблюдений схемы 1 не доказывают нативный допуск.

scripts/freeze-ew.mjs однократно принимает проверенные калибровочные записи, требует здоровый контроль в пределах 1 м и отказывается перезаписывать диапазоны. Заранее заданное эмпирическое правило: округление вверх до 0.01 от 1.5-кратного максимума калибровки плюс запас 2 м для позиции/траектории или 0.5 для инноваций. Режимы калибровки образуют допустимое множество; неожиданные режимы требуют расследования. Хеши прошивки, эффективных входных параметров, модели, плана и исходников должны совпадать. Новая валидационная серия должна пройти закреплённые пределы и независимый допуск здорового контроля; хеши калибровочных записей не могут валидировать сами себя. Это регрессионные пределы для конкретной версии синтетического нативного стенда, а не измеренная точность самолёта, браузерный READY, записанный Simulation-on-Hardware, гарантия fallback-режима или обход EKF gate.

Нативный допуск TASK-059: проходят все шесть калибровочных случаев и шесть отдельных валидационных, с 710636 восстановленными кадрами физики. Неизменная матрица и исходные нативные отчёты/архивы сохраняют нездоровые флаги и режимы, вызванные воздействиями. Подавление и дрейф достигли Land; шаг позиции поднял флаги GPS-glitch; магнитное смещение увеличило отношения инноваций компаса, сохранив Guided; полная потеря ротора вызвала кувырок и контакт с синтетическим полом в окне 3 с. В закреплённом Copter ekf_check.cpp критерии дисперсий компаса, скорости и позиции объединяются до действия failsafe, поэтому инновация одного компаса не обещает Land. Здоровый полёт TASK-042 также повторно прошёл. Точные идентичности и документированные повторы из-за окружения см. в test-results/validation/task-059-native.json, task-059-tests.json и task-059-completion.json.

GPU-анализ требует M4 или RTX4050, ОС/браузер/питание/backend, видимую production-сцену, все terrain/FPV/thermal, прогрев>=60 с и измерение>=600 с. Положительные конечные интервалы кадров должны покрыть длительность с точностью 0.02 с. 2026-10-21 пользователь принял для 60 FPS медиану 16.680 мс и p99 17.665 мс после округления до 0.001 мс и принял панель 59.88 Гц для этого профиля. Предел p99 для 120 FPS остаётся 8.33 мс и применяется на панели с частотой не ниже 120 Гц. GPU<=2 GiB и CPU-кеш<=512 MiB. Изображение полёта должно заполнять активный физический дисплей. Эмулированный viewport 1920x1080 не доказывает показ в режиме 2560x1440 или на штатной матрице MacBook Air 2560x1664. Программный/headless-рендеринг не проходит. Импортированные трассы требуют проверки исходного профилировщика.

Системные свидетельства сопоставляют точные G0/G1/G2/G3/G4 ID режимам demo, external-sitl, wasm-sitl и hitl. Отсутствующее требование — NOT_RUN; любой FAIL проваливает режим; иначе неполное покрытие блокирует. PASS требует observed source, ожидаемый путь отчёта, точный хеш, совпадающую ревизию и исходный PASS правильного вида. Пустые, повторные, неизвестные и устаревшие декларации режим не сертифицируют. Старые численные отчёты не превращаются молча в физический PASS. Инвентарь выпуска проверяет собственные generated-файлы, пределы байтов, хеши, лицензии и фактические метаданные; полная проверка лицензий/сборки/чистой машины/исходных свидетельств остаётся заблокирована. Скрипты выпуска ничего не публикуют.

### Collision-решётка рельефа v1

HeightTile имеет version=1, epoch/revision uint32, целые northIndex/eastIndex в ±1024, resolution 2..257, spacingM в (0,100] и resolution² конечных downM в ±15000 м. Все горизонтальные узлы остаются в локальных 15 км. Ряд растёт на север, столбец на восток; начало фиксировано в NED. Ячейка имеет треугольники [a,a+1,a+n] и [a+1,a+n+1,a+n] с нормалью -Down. Высоты сохраняются Float64; вершины — Float32. Квантование вершин добавляет до примерно 1 мм в этом диапазоне и не устанавливает физическую точность рельефа.

Построение выполняется отдельным Worker. Stage владеет копией, проверяет epoch/решётку, возрастающие ревизии, точные высоты общих рёбер и фиксированную ёмкость 1..256 (по умолчанию 64). Сумма active+pending-буферов ограничена байтами (по умолчанию 64 MiB, настраивается до CPU-предела 512 MiB); до публикации замена должна вмещать старые и новые данные. Publish заменяет указатели только при строго возрастающем тике нужного epoch. Визуальные ресурсы не могут вытеснить collision-поверхность. downAt/sampleInto используют треугольную поверхность, не билинейную интерполяцию. Без земли возвращается NaN; readyAround/readyFrom требуют все плитки защитного квадрата с радиусом<=половины чанка. Высокочастотный интерфейс использует готовые typed-array входы/выходы; скалярные методы холодные. Связь контакта с рельефом TASK-065 ниже подключает её к контактному владельцу Rapier; живой допуск рельефа в полётную сессию остаётся отдельным. Декодирования файлов внутри физики нет.

### Декларативный сценарий v1

Допуск копирует и замораживает id, hz 400/800/1200, uint32 seed, SHA-256 модели/прошивки, длительность 1..4320000 тиков, <=128 упорядоченных событий и рубрику удержания высоты. Допускаются только проверенные шаблоны weather.set/fault.set протокола v2, expectedEpoch=0, requestId подряд от 1 и atTick, точно равный тику события. `ScenarioBinder` привязывает действующий epoch, выделяет следующий допустимый request id, отправляет команду через очередь сессии на этом тике и объявляет отказ применённым только после ACK applied. Runner возвращает неизменные индексы, не выделяет память в polling и использует симуляционные тики; пауза не расходует время. Обратный/пропущенный тик даёт -2 вместо позднего исполнения. Reset явно возвращает курсор. Несовпадение происхождения/seed/hz отклоняет запуск.

Рубрика требует каждый целый тик удержания ровно один раз, конечную высоту, реальный источник автопилота и здоровый EKF по настройке. Пробелы, превышение высоты и нездоровый EKF проваливают проверку; неполные/синтетические трассы блокируют. Pilot-basics содержит нулевые хеши только для структурных тестов, это не сертифицированный урок борта/прошивки. Валидация нативного замкнутого контура SITL РЭБ (TASK-042/043/059) завершена. TASK-075 допускает команды инструктора `fault.set` в `EwEngine` живой сессии. TASK-079 отправляет отказы сценария на их тике и ждёт ACK applied. События погоды на demo остаются отклонёнными. Хеши-заглушки урока не являются сертифицированным уроком.

### Доступное взаимодействие

Реализованы видимый клавиатурный фокус, skip-to-controls, явное время replay, live-статус разрешений и возврат фокуса после Serial permission. Отказ не запускает повторный prompt. Фокус не отбирается у другого контрола и не возвращается отсоединённому элементу. Axe-скан и браузерные keyboard/390px-проверки упражняют демо; физическое устройство и экранный диктор проверяются отдельно. Прежний низкий контраст footer исправлен без отключения правил сканера.

## Стационарные коэффициенты пропеллера для сравнения с измерениями (TASK-033)

`mirage_bet::propeller::steady_point(rotor, radius_m, spin_sign, condition)`
вычисляет BET раздела 3 с заданными RPM и равномерной индуктивной скоростью
v >= 0. Эта скорость — корень `T_BET(v) = 2*rho*A*v*(V + v)`, то же осевое
замыкание активного диска, к которому релаксирует `AxialInflow`. Бисекция
выполняет 80 итераций на [0, Omega*R]. Это офлайн-обвязка валидации, она
никогда не выполняется в цикле шага.

Пропеллер движется вдоль +z, поэтому скорость воздуха в осях втулки равна
(0, 0, -V). Используется соглашение аэродинамической трубы:

* n = RPM/60 об/с, D = 2R и V = J*n*D;
* CT = T/(rho*n^2*D^4) и CP = P/(rho*n^3*D^5), где P = -s*Q_air*Omega;
* eta = J*CT/CP.

Если тяга при v = 0 неположительна (авторотация или торможение), замыкание не
применяется: v = 0 и устанавливается `outside_momentum_validity`.

Закрутка потока, концевые потери и неравномерный индуктивный поток не
моделируются. Поэтому расхождения с измерениями включают эти эффекты вместе с
неопределённостью поляры, и о них нужно сообщать, а не подгонять.

`cargo test --test propeller` проверяет четыре точных оракула независимо от
набора данных:

* при CD = 0 выполняются P = T*(V + v) и eta = V/(V + v);
* стационарная цель `AxialInflow` равна v;
* коэффициенты восстанавливают T и P;
* сопротивление увеличивает CP и снижает eta, а зеркальное вращение не меняет результат.

## Сравнение с базой данных пропеллеров UIUC (TASK-033)

Измерительный адаптер `uiuc-propeller-bet-v1` сравнивает `steady_point` с базой
данных пропеллеров UIUC (тома 1-4) на напечатанных на 3D-принтере пропеллерах
DA4002 и DA4022. Их профиль, SDA1075 по всей лопасти, опубликован в
AIAA 2014-2151, приложение A. Архив, инвентарь, статус прав и команды
повторной генерации описаны в
[руководстве по данным UIUC](uiuc-propdb-data.md).

Путь данных: `tests/fixtures/rotors/uiuc/generate_uiuc_propellers.py` проверяет
закреплённый дайджест архива и пишет зарегистрированную измеренную фикстуру
`tests/fixtures/rotors/uiuc-propellers.json`. `packages/physics/src/uiuc-propeller.ts`
проверяет её и строит объявленную модель. `native/bet/examples/propeller_points.rs`
вычисляет BET офлайн через строчный протокол, а `scripts/validate-models.mjs`
формирует отчёт. Сравнение никогда не входит в цикл шага.

### Объявленная модель и допуски

Эти решения зафиксированы в фикстуре и коде до первой оценки:

* лопасть: SDA1075 от r/R = 0.30 до конца, 28 равных полос со средними
  точками; измеренные хорда и крутка интерполируются линейно. Область втулки
  0.15 ≤ r/R < 0.30, где профиль не указан, исключена. Две лопасти, если
  прогон не помечен 3b/4b; вращение +1.
* поляра `thin-airfoil-laminar-friction`:

  ```text
  CL = 2*pi*(alpha - alpha0)
  CD = 2*1.328/sqrt(Re)
  alpha0 = -(1/pi) * integral_0^pi (dz/dx)*(cos(theta) - 1) dtheta,  x = (1 - cos(theta))/2
  ```

  alpha0 = −1.341 град по средней линии SDA1075. Таблица охватывает
  alpha0 ± 10 град, 1e3 ≤ Re ≤ 5e5 и Ma 0–0.3. Запрос за её пределами
  ограничивается и помечается `PolarTable`; помеченная точка сообщается как
  `outsidePolar` и не сравнивается.
* индуктивный поток: равномерный осевой импульс (раздел «Стационарные
  коэффициенты пропеллера»); точки авторотации — `outsideMomentum`, не
  сравниваются. Концевые потери, закрутка и неравномерный поток не
  моделируются.
* состояние атмосферы: ISA на уровне моря (1.225 кг/м^3, 1.789e-5 Па с,
  340.294 м/с), так как архив не содержит состояния для каждого прогона.
* допуск для каждой сравниваемой точки: |dCT| ≤ max(0.10·|CT|, 0.005) и
  |dCP| ≤ max(0.10·|CP|, 0.003); оба условия обязательны. Статус `failed`,
  если любая сравниваемая точка провалена или исполнитель вернул ошибку,
  `pass`, если все сравниваемые точки прошли, и `unvalidated`, если ни одна
  точка не сравнивалась. `unvalidated` никогда не считается PASS.
* согласованность: до любого сравнения оракулы набора данных (согласованность
  eta и предел Фруда, см. руководство по данным) должны дать ноль нарушений
  и совпасть со счётчиками аудита генератора.

### Результат (2026-10-17)

`node scripts/validate-models.mjs` завершается с кодом 2: fidelity пропеллеров
`failed`, согласованность `pass`, счётчики аудита 716/674/0/0. Из 958 точек
сравнивались 534, ни одна не выдержала оба допуска, 101 выдержала допуск CT
и 154 — допуск CP. 389 точек вне области поляры (все
242 статические точки и 147 точек с J ≤ 0.52), 35 — в режиме авторотации.

Признаки соответствуют объявленным упрощениям:

* средняя ошибка CP у DA4002 составляет от −0.002 до −0.012 в семи из восьми
  конфигураций (+0.0001 в восьмой). Ламинарное трение не учитывает
  сопротивление давления и ламинарного пузыря. Средняя ошибка CT остаётся в
  пределах ±0.013.
* средняя ошибка CT у DA4022 составляет от +0.020 до +0.067, средняя ошибка CP —
  от +0.005 до +0.024. Обе растут с числом лопастей (заполнением), что
  согласуется с отсутствием концевых потерь и равномерным потоком.

Значения по точкам пишутся в `test-results/validation/propeller-points.json`.
Их нельзя устранять подгонкой: для PASS нужны поляра из измерений или вязкого
решателя и, при необходимости, объявленная модель потока/концевых потерь,
каждая со своим происхождением.

### Сравнение с полярой XFOIL (2026-10-17)

Второй измерительный адаптер, `uiuc-propeller-bet-xfoil-v1`, использует ту же
лопасть, индуктивный поток, атмосферу и допуски. Меняется только поляра: синтетическая
фикстура `tests/fixtures/polars/sda1075-xfoil.json` (id `sda1075-xfoil-699-v1`).
Её создал `tests/fixtures/polars/generate_sda1075_xfoil.py`, запустив MIT XFOIL
6.99 для Windows (SHA-256 exe
`c17342f84ae260c2b11a74cd0e2fb8189a5f8954c6bb7a8467a0f27055c7faea`, из
`XFOIL6.99.zip`, SHA-256
`e13e8fe5cc38d8ac2626e9d3b17643bdcfaa63791619f042afdaa7cd103bcb08`) на
переносе координат SDA1075. Настройки зафиксированы до оценки:

* перепанелизация PANE по умолчанию, свободный переход с Ncrit = 9, Mach 0, ITER 200;
* развёртки 0 → +14 град и, после INIT, −0.5 → −8 град с шагом 0.5 град;
* Re = 2e4, 3e4, 4e4, 6e4, 8e4, 1e5, 1.5e5 и 2e5, каждое в новом процессе.

Таблица сохраняет наибольший непрерывный диапазон alpha вокруг 0 град, сошедшийся
при всех Re: от −7.5 до +7.5 град; его ограничивает Re = 3e4 (32 сошедшихся
угла). Ma 0 дублируется при Ma 0.3; число Маха на конце лопасти в этих прогонах
не выше 0.21. Запросы за пределами таблицы помечаются и не сравниваются. Два запуска
генератора с тем же бинарным файлом дают побайтно одинаковый результат.

Результат: fidelity пропеллеров `failed`. Из 958 точек сравнивались 165, оба
допуска выдержали 26; 723 вне поляры, 70 в режиме авторотации.

* DA4002 9×6.75: проходят все 16 сравниваемых точек; с аналитической полярой не
  прошла ни одна.
* DA4002 9×2.85: проходят 10 из 13 сравниваемых точек.
* DA4002 9×8.95: CP проходит во всех 20 сравниваемых точках; CT в среднем
  завышен на 0.014.
* DA4022 9 дюймов: CT завышен на 0.024–0.041, CP — на 0.014–0.026, оба растут с
  числом лопастей. Это согласуется с отсутствием концевых потерь и равномерным
  потоком, а не с данными профиля.
* пропеллеры 5 дюймов: ни одна точка не сравнивалась, так как корневые сечения
  работают ниже Re = 2e4.

Поляра XFOIL — результат решателя, а не измерение профиля. Для PASS всё ещё
нужно объяснить оставшиеся ошибки DA4022 объявленной моделью концевых потерь или
индуктивного потока.

## Таблицы пропеллеров JSBSim из данных UIUC (TASK-086)

`data/jsbsim/generate_uiuc_propellers.py` пишет файлы пропеллеров фиксированного
шага JSBSim в `data/jsbsim/engine/`, путь двигателей моста. Каждый файл содержит
внутренние таблицы `C_THRUST` и `C_POWER` в зависимости от J; определения JSBSim
CT = T/(rho n^2 D^4) и CP = P/(rho n^3 D^5) совпадают с таблицами UIUC, поэтому
строки копируются без изменений. Таблицы JSBSim зависят только от J, и для
каждого пропеллера одно значение RPM выбирается по фиксированному правилу:

* прогоны в одном интервале 250 RPM образуют группу;
* выбирается группа с наибольшими RPM, развёртка которой доходит до CT ≤ 0;
* строка J = 0 берётся из статической таблицы при ближайших RPM.

Поэтому зависимость от числа Рейнольдса между разными RPM не представлена, а за
последним измеренным J JSBSim удерживает крайнее значение. ixx не записывается,
так как момента инерции в данных нет.

`node scripts/check-jsbsim-propellers.mjs` проверяет нативную загрузку в
закреплённом JSBSim v1.2.3 (коммит и хеш лицензии из
`native/jsbsim/source.lock.json`; задать `JSBSIM_SOURCE_DIR`). Без checkout
скрипт завершается с кодом 2 (BLOCKED_EXTERNAL), при проваленной точке — с
кодом 1. Он работает в пять шагов:

1. Собирает `native/jsbsim/propeller_probe.cpp` отдельным проектом CMake
   `native/jsbsim/propeller/`, не меняя файл сборки моста TASK-031.
2. Копирует каждое определение побайтово (SHA-256 из манифеста проверяется) во
   временный корень с пробным самолётом. У самолёта один электродвигатель,
   нулевая аэродинамика и неиспользуемая точка контакта с землёй.
3. Загружает его через `FGFDMExec::LoadModel` и выполняет начальные условия на
   уровне моря ISA со скоростью V = J n D в осях тела.
4. Вызывает `FGPropeller::Calculate` при группе RPM таблицы. Тяга вычисляется
   по RPM на входе, до интегрирования RPM.
5. Сверяет результаты с измеренными строками.

Проверяются:

* загруженный диаметр равен значению манифеста / 12 ft;
* сообщаемое J равно заданному с точностью 1e-9;
* плотность отличается от ISA (1.225 kg/m^3 = 0.0023769 slug/ft^3) не более чем на 1e-4;
* тяга и мощность в пределах 1% от CT rho n^2 D^4 и CP rho n^3 D^5.

Точки объявлены до запуска: статическая строка; строка, CT которой ближе всего
к половине статического CT; и середина до следующей строки, сверяемая с линейной
интерполяцией.

Результат (2026-10-18, Linux, GCC, CMake 3.28): все 6 файлов загружаются, 18 из
18 точек проходят. Наибольшая ошибка тяги 4.1e-16, ошибка плотности 8.1e-6.
Отчёт — `test-results/validation/jsbsim-propellers.json`.

v1.2.3 присваивает `FGPropeller::Ixx` только при наличии `<ixx>`; значения по
умолчанию нет. Поэтому полётная модель с этими файлами должна добавить момент
инерции вращающихся частей до интегрирования RPM. Проба никогда не читает Ixx и
не проверяет динамику RPM и связь с двигателем.

## Нативный замкнутый контур SITL (TASK-042)

Linux-драйвер с владением процессами — `scripts/sitl/driver.mjs`, с закреплённым
sidecar pymavlink 2.4.50 (`telemetry.py`). Он запускает нативный ArduCopter ELF
из чистых закреплённых исходников ArduPilot и существующий WASM тела Rust RK4
через `BetRigidBodyBackend`. Используется синтетический quad X, а не
калиброванные поляры BET, характеристики самолёта JSBSim или браузерное демо.
Масса, инерция, плечо, кривая тяги, реакция рыскания и лаг моторов явно заданы
в `quad.mjs`. Неупругая горизонтальная плоскость устраняет проникновение;
это не модель шасси Rapier и не приёмка произвольного рельефа. Движение
интегрирует только Rust.

Обмен физики идёт на 800 Hz для проверки частоты гироскопа при стандартном
планировщике Copter 400 Hz. Начальные объявленные 1200 Hz — исходное значение
Aircraft; временные метки JSON задают 800 Hz, передаваемые как 799/800 из-за
усечения float. Повторы получают идентичные байты; пропуски, перезапуски,
некорректные пакеты и неожиданные частоты приводят к отказу полёта. Файлы
хешируются до запуска и проверяются на неизменность после него. Дочерние
процессы входят в собственную POSIX-группу harness; завершаются только они.
На Windows весь harness работает внутри WSL: завершение Windows-процесса
не считается удержанием Linux-потомков. UDP/TCP привязаны только к loopback.
Требуется новый каталог захвата; старые свидетельства не перезаписываются.

Прогрев занимает не менее 30 модельных секунд и ждёт настоящие свежие heartbeat
и EKF. Нужны биты ориентации, горизонтальной/вертикальной скорости, абсолютной
горизонтальной/вертикальной позиции; неинициализированное состояние или
отношения инноваций вне [0,1) отклоняют здоровье. Возраст heartbeat, EKF и
высоты автопилота не превышает одной модельной секунды. Проверки arming/EKF
не отключаются. Команды Guided, arm, takeoff, land передаются через MAVLink;
приёмкой управляют реальные mode/armed heartbeat, а не намерение команды.
И истинная высота, и оценка автопилота должны пройти прежний допуск удержания.
Прогрев сохраняется в сырых захватах; оцениваемый полёт начинается после
настоящего здорового вооружения.

Трасса v2 добавляет `physicsHz=800` и `captureStride=8`. Отсчёты имеют 100 Hz,
сохраняют исходные счётчики кадров firmware (произвольный начальный сдвиг,
шаг восемь) и интервал меток 0.01 s. Каждый отсчёт добавляет к прежним полям
`heartbeatAgeS`, `ekfAgeS`, `ekfFlags`, пять `innovationRatios`,
`autopilotAltitudeM` и `altitudeAgeS`. Полночастотная физика и сырой MAVLink
остаются отдельными свидетельствами. Legacy v1 сохраняет исторические тесты
схемы; новая нативная интеграция использует v2. Прежние требования 3 m при
взлёте, 10 m +/-1 m не менее 10 s, посадка ниже 0.5 m с разоружением,
режимы 4/9 и предел родителя 120 s неизменны. Этап `arm` включает начальный
подъём до порога взлёта 3 m; `takeoff` — оставшийся набор, а `hold`
начинается только после стабилизации.

Захват содержит `flight.json`, `run.json`, `physics.ndjson`,
`telemetry.ndjson`, `mavlink.raw`, stdout/stderr firmware и собственные
DataFlash-логи. Истина модели отделена от оценок автопилота; сохраняются
команды, runtime, хеши исходников, идентичность бинарника/модели и очистка.
Итоговый отчёт связывает реальные байты захвата; неудачные попытки сохраняются
отдельно. Нативный интеграционный PASS не включает браузерный autopilot READY,
не сертифицирует измеренную аэродинамику, HITL или тайминги целевого устройства.

## Кольцевая BEM-диагностика пропеллера по источникам (TASK-033)

Добавлена автономная диагностика, а не рабочий ABI динамики. Исходная модель
равномерного потока и фиксированные допуски CT/CP сохранены.

### Источники и ограничения

Предоставленная статья AIAA 2014-2151 связывает существующий эксперимент UIUC
с идентичностью лопастей. Диссертация Deters добавляет проектную/изготовленную
геометрию (3.2), осевую/тангенциальную индукцию (4.2), ограничения XFOIL при малых
Re (6.2) и след за пропеллером (глава 8). Приложение A.2 точно совпадает с
существующей транскрипцией SDA1075 из 61 точки. В диссертации поляра XFOIL при
Re=20000 дала прогнозы пропеллера, не согласующиеся с экспериментом. Расширение
расчётного покрытия само по себе не устанавливает достоверность. Наша фикстура
уже использует сканированную геометрию; дополнительная подогнанная поправка шага
не вводится.

PROPID 5.3.1 документирует единицы slug/ft, средние точки, концевые/корневые
потери Prandtl и закрутку. Он указывает MODE=2/INCV=1 для пропеллеров, но не
документирует режим. `node scripts/check-propid.mjs --run` проверяет хеши и
выполняет комплектный пример турбины в ограниченном каталоге кеша. Он проходит
с исходным предупреждением о Reynolds. Отдельный синтетический опыт пропеллера
не установил соглашения скорости/знака и не принят как паритет. Отчёт:
`test-results/validation/propeller-source-review.json`; исходные ресурсы локальны
и игнорируются. Измеренная закрутка ниже по потоку не равна индукции в плоскости
ротора: для главы 8 нужны преобразования станции/сжатие следа.

`neel542/airfoil-research`, проверенный на коммите
`27c6eb2a37e4f157ae62bd485b3686949b103698`, — дополнительный эталон реализации и
неопределённости. Его 14 статических исходных файлов точно совпадают с нашими
UIUC, а не дают новые независимые эксперименты. Общая проверка профилей
начинается при Re=60000. Исследование пропеллера использует статические случаи,
сводное окно Re>=40000, аппроксимацию геометрии Kulfan и иные правила потерь/
корней/поляр. Мы не импортируем его подгонки ошибок, окно приёмки, прогнозы
NeuralFoil или заполненные пробелы XFOIL как измерения. Python-код просмотрен,
но не исполнялся.

### Кольцевая диагностика

Предоставленный `task_033_sda1075_polar_propid_handoff.md` проверен как
вторичный источник, а не инструкция по приёмке. Заявленная оцифровка явно
противоречит Figure 30 статьи (страница PDF 22): при alpha=0, Re=40000
график даёт Cl около нуля, а не 0.30; при alpha=20, Re=100000 — примерно
0.63, а не 0.97. Приблизительное чтение графика выявляет противоречие,
но не заменяет ячейки поляры. В документе нет калибровки оцифровки или
неопределённости; таблица не импортирована. Существующий сырой результат
XFOIL 6.99 при alpha=0, Re=40000: Cl=-0.0322, Cd=0.02661; различия
решателей/настроек требуют отдельной фиксации происхождения.

Официальная документация NeuralFoil описывает нейросетевую суррогатную
модель, обученную на расчётах XFOIL, с выходом analysis-confidence.
Гладкое вычисление не является сошедшимся решением пограничного слоя или
измеренной точностью при Re=5000. Viterna расширяет угол атаки, но не
обеспечивает отсутствующую применимость по числу Reynolds. Будущее расширение
должно отдельно обозначать сырой расчёт, оцифрованный расчёт, суррогат и
экстраполяцию угла, а также флаги выхода за диапазон Reynolds. Проверенные
источники не доказывают отсутствие измерений SDA1075 где-либо ещё.
Откладывание NASA касается достоверности шасси, а не валидации всего самолёта.
Артефакт проверки: `test-results/validation/task-033-handoff-review.json`.

`native/bet/src/propeller_bem.rs` уравновешивает каждое кольцо в средней точке
с осевой скоростью V+u и тангенциальной Omega*r-w в плоскости ротора.
Нагрузки импульса на единицу радиального размаха:
`dT/dr = 4*pi*rho*r*F*u*(V+u)` и
`dQ/dr = 4*pi*rho*r^2*F*w*(V+u)`. Исходные концевой/корневой факторы Prandtl
образуют F и умножают импульс, а не произвольный масштаб полной тяги. Слабо
тормозящие кольца допустимы при V+u>=V/2; неположительные полные тяга/мощность
лежат вне применимости. Windmilling и торможение с большой индукцией не сертифицированы.

Ограниченный демпфированный Newton использует вложенную бисекцию закрутки/осевой
индукции как резерв. Поиск расширяется; фиксированная доля окружной скорости
не является порогом допуска индукции. Отсутствие корня даёт ошибку, а не успех
с нулевым потоком. Единственность/устойчивость нескольких корней не сертифицирована:
Newton находит локальный баланс, резервный поиск — первый интервал смены знака.
Сходимость требует относительной невязки <1e-9 по локальному масштабу силы
вращающейся лопасти. Покрытие определяется только итоговыми запросами секций;
ограниченные границей поляры значения не допускаются как валидное сравнение.

Холодный пример принимает `--annular`, `--no-tip-loss`, `--no-hub-loss` и
`--no-swirl`. В режиме annular пятый числовой выход — безразмерная невязка;
неизменённый legacy-режим выдаёт ньютоны. Записи `bem` в stderr содержат
сходимость, применимость, невязку, итоговые экстремумы alpha/Re, средние
индукцию/закрутку и коэффициенты. Это автономный инструмент, не C/SAB-интерфейс.

`node scripts/check-propeller-bem.mjs` выполняет четыре явных варианта с теми же
зарегистрированными измерениями и XFOIL. Все три кольцевых варианта сходятся
на 958 точках. Полные потери/закрутка сравнивают 193 точки: 48 проходят оба
допуска, 690 вне поляры, 75 вне применимости импульса. Исходный равномерный поток
воспроизводит 165 сравнённых/26 прошедших. На 159 общих точках кандидат даёт
39 проходов против 26, с 35 улучшениями и 22 ухудшениями. Разное покрытие и
смешанные изменения исключают заявление об общем улучшении/fidelity PASS.
Результаты, хеши исходников/программы, парные точки и области запросов:
`test-results/validation/propeller-bem.json`. Код 0 кольцевой диагностики означает только завершение исследования чувствительности; код 2 в `validate-models.mjs` сохраняет различие между численным паритетом, непройденной достоверностью пропеллера и заблокированной достоверностью самолёта.

## Связь контакта с рельефом: контактный ABI v2 (TASK-065)

Решение: топология Rapier остаётся фиксированной, вместо пересоздания коллайдеров
перемещаются плоскости. Инициализация контакта вставляет по одному неподвижному
полупространству на каждый слот контакта: слот 0 для сферы планера и слоты 1..8
для колёс. У каждого слота своя пара групп столкновений, поэтому полупространство
взаимодействует только со своей сферой или ободом. Перед каждым шагом владелец
интеграции берёт опубликованный треугольник решётки под каждой точкой контакта и
передаёт эти плоскости. Неподвижные тела меняют положение; коллайдеры в
вооружённом состоянии никогда не вставляются и не удаляются.

`contact_abi_version()` равен 2, вход растёт с 16 до 52 значений:

| Индекс | Значение |
| --- | --- |
| 0..15 | вход v1 (wrench, тормоза, dt); индекс 15 теперь режим плоскостей |
| 15 | 0 = заданная плоскость для всех контактов (поведение v1); 1 = плоскости на каждый тик |
| 16 + 4*s .. 19 + 4*s | плоскость слота s [nN, nE, nD, offsetM]; s = 0 планер, s = 1 + i колесо i |

Переданной плоскости нужны единичная нормаль (|n|^2 - 1 в пределах 1e-9),
направленная вверх (nD < 0), и конечное смещение. Точка x находится на высоте
n.x - offset над ней. В режиме 0, а также для слотов за пределами заданных колёс
все значения плоскости должны быть 0. Любое другое значение отклоняет шаг с кодом
-2 без изменения состояния. Для каждого колеса прогиб шины, разложение на
продольную и боковую составляющие, нормальная сила и диагностика расстояния до
плоскости используют плоскость этого колеса. Упор обода использует своё
полупространство. Сфера планера использует слот 0, а сообщаемая точка корпуса
лежит вдоль этой нормали. Холодная инициализация до вооружения также проверяет
перемещение плоскостей на каждой частоте. Существующая проверка аллокатора на
шаге по-прежнему переводит сессию в отказ при любой аллокации.

`CollisionChunks.planeInto(position, out)` записывает плоскость того же
треугольника сетки, что и `sampleInto`, с точным градиентом этого треугольника и
NaN при отсутствии земли. `TerrainContactCoupler`
(`packages/physics/src/terrain-contact.ts`) владеет заранее выделенными буферами.
Каждый `stepInto`:

1. требует `readyFrom` по защитному квадрату не меньше охвата креплений колёс;
2. берёт слот 0 в центре масс, а каждое колесо в горизонтальном положении
   R(q)·anchor;
3. вызывает `GroundContact.stepInto(..., groundPlanes)`.

При отсутствии земли возвращается `TERRAIN_PAUSED_MISSING_GROUND`: шаг не
выполняется, состояние не меняется. Отклонённый шаг возвращает `TERRAIN_REJECTED`.

Ограничения:

* Выборка использует полностью выпущенное крепление, а не мгновенное пятно контакта.
* Кривизна внутри одного треугольника и ребро треугольника под пятном шины
  представлены одной плоскостью под точкой выборки.
* Связь пока не подключена к полётной сессии (активен демо-backend).
* Декодирование живых плиток и допуск рельефа остаются отдельной работой.


## Локальная сборка ArduPilot WASM и браузерный допуск (TASK-045)

Штатная плата wasm на 8ab6afde107a91df1b5f60ade8f333cb8a61b190 остаётся закреплённой на Emscripten 4.0.15. Чистая сборка продолжения воспроизвела включённые идентичности модуля 3730330 байт (556d97fa6dbf7c0a2cf713f6106a6891de0b9bc9c5a7dd945f1789b63e58df38) и glue 258215 байт (b158a7b8e9b400c770e2b4fc87c66fc2aaf68bc583c7d71f3a56786d3bcb4212). Сборщик проверяет HEAD/чистоту исходников, закреплённые байты HAL/лицензии, коммиты submodule, коммит/манифест SDK и версию/коммит компилятора. Он требует новые/пустые каталоги, не удаляет переданный каталог, сохраняет build.log и отклоняет отличие от включённого манифеста артефакта. Версия 6.0.8 в CI ArduPilot остаётся отдельной; этот допуск проверяет неизменную версию проекта 4.0.15.

При явном MIRAGE_ARDUPILOT_WASM_DIR dev-сервер Vite допускает закреплённые локальные байты и выдаёт только manifest.json, arducopter.js и arducopter.wasm по /__local-ardupilot/. Проверяются GET, loopback-адрес клиента, loopback Host и Origin того же host; чужие fetch, запись и неизвестные файлы отклоняются. Без настройки и в production-сборке маршрута нет. Артефакты остаются локальными с distribution=local-only-pending-gpl-review. Существующее решение о распространении остаётся открытым; bootstrap не добавляет прошивку в public/ или dist/.

BrowserWasmSession работает внутри выделенного ardupilot.worker.ts. Холодный протокол Worker версии 1 допускает точные формы start/serial/checkpoint/stop и <=4096 байт serial в необщем буфере. Для запуска нужны crossOriginIsolated и SharedArrayBuffer, same-origin база артефактов, WASM <=64 МиБ и glue <=4 МиБ. До выполнения существующий допуск проверяет хеши, экспорты, импорты и память. Blob URL из проверенной glue также служит точкой входа pthread, а проверенный wasmBinary передаётся напрямую, исключая вторую непроверенную загрузку. Импортируемая общая память начинается с 16 МиБ при максимуме 2 ГиБ; наблюдаются четыре настоящих pthread Worker, лимит хоста — 16 дочерних. Диагностический супервизор ограничивает запуск 30 с и остановку 20 с. Явная остановка освобождает serial-буфер, завершает дочерние Worker, закрывает хранилище и снимает lease профиля; внезапное завершение родителя отдельно проверяется на очистку детей.

Serial-мост опрашивается порциями <=4096 байт каждые 25 мс. Три HEARTBEAT с верным CRC от system/component 1/1 дают диагностическое событие booted. Booted независимо от READY автопилота, здоровья EKF и допуска полёта. PARAM_REQUEST_READ (20, CRC 214, payload 20 байт), PARAM_VALUE (22, CRC 220, 25 байт) и PARAM_SET (23, CRC 168, 23 байта) расширяют закреплённое подмножество кодека независимыми байтовыми фикстурами pymavlink 2.4.50. Настоящий параметр этой версии — WP_SPD в м/с, а не удалённый WPNAV_SPEED. Реальные тесты хранилища читают исходное значение, задают 8.125 м/с и проверяют CRC-подтверждённый ответ прошивки после штатного и внезапного перезапуска Worker. Встроенный квадрокоптер остаётся disarmed; сопряжение физики/времени/датчиков/актуаторов MirageSITL относится к TASK-046, нативный паритет — к TASK-047.

Штатный POSIX Storage по умолчанию использует eeprom.bin размером 16384 байт. Неизменная glue предоставляет FS, но не IDBFS, поэтому EepromStore сохраняет настоящий файл в IndexedDB: база mirage-ardupilot-eeprom-v1, store profiles. Ключ связывает коммит прошивки, хеш модуля и профиль длиной 1–64 символа. Запись схемы 1 содержит identity, возрастающую revision, полный image и SHA-256; загрузка проверяет поля и байты, повреждение блокирует запуск без стирания. Web Lock исключает одновременное владение профилем прошивки; readwrite-транзакция со сравнением revision не допускает конкурирующих авторов checkpoint. Тесты проверяют конфликты и сохранение при отмене транзакции. preRun восстанавливает проверенный файл до main прошивки. Автоматический checkpoint рассматривается каждые 2 с после запуска; требуется одна секунда неизменных байтов файла, попытка стабилизации ограничена 10 с. Явная остановка дожидается/сохраняет checkpoint перед освобождением. Только подтверждённый checkpoint обещает сохранность; несохранённые изменения могут потеряться при внезапном завершении. Это холодный bootstrap/хранилище, а не сертифицированный высокочастотный flight HAL, полный AAR-рекордер или изменение SAB ABI.

Локальная диагностическая страница — ardupilot-check.html. Её ограниченные исходные потоки и три полных EEPROM-образа независимо проверяет scripts/check-ardupilot-browser.py с pymavlink 2.4.50 и hashlib. Аудит проверяет исходные HEARTBEAT disarmed с верным CRC и значения параметров, идентичность прошивки, память/потоки, сохранённые revision, хеши полных образов и отсутствие оставшихся Worker. Unit-фикстуры помечены synthetic и не заменяют реальное браузерное свидетельство.

## Синхронный HAL-mailbox ArduPilot v1 (TASK-046)

HAL-прошивка — отдельная локальная сборка закреплённой upstream ArduCopter.
`scripts/build-ardupilot-hal.mjs` проверяет исходники/SDK/компилятор и субмодули,
копирует исходники в принадлежащую задаче `/tmp/mirage-task-046-*`, применяет
`native/ardupilot/hal/sitl-state.patch` и добавляет ядро HAL. `--resume`
проверяет/снимает/повторно применяет только этот патч перед компиляцией.
Оригинальные исходники и артефакт TASK-045 сохраняются. Выходы и отдельные
манифест/идентичность сборки находятся в `.cache/task-046/`; прошивка локальная.
Upstream-шаг WASM FDM принимает внешние наблюдения вместо продвижения своего
квадрокоптера, затем использует прежний `stop_clock(timestamp_us)`.
Собственная обработка датчиков и частоты задач ArduPilot сохраняются.

Экспорты: `mirage_hal_version()->u32`, `mirage_hal_mailbox()->pointer`,
`mirage_hal_configure(hz,epoch)->i32`, `mirage_hal_notify()` и
`mirage_hal_stop()`. Версия 1 использует mailbox 1024 байта с выравниванием
64 байта в разделяемой линейной памяти прошивки. Все обращения к разделяемым
данным — атомарные u32; float64 кодируется младшим/старшим little-endian
словом через приватный буфер. Это независимая граница C ABI; байты и владение
полётных ABI-v2/SPSC не меняются. Разделяемый Float64Array запрещён.

Заголовок u32, слова 0..15: magic `0x4d48414c`, версия 1, размер 1024, состояние,
частота физики, ненулевая epoch, младший/старший завершённого тика, входная
последовательность хоста, выходная последовательность прошивки, код ошибки,
число PWM-каналов 32, armed (0/1), нулевой резерв, младший/старший timestamp-us.
Configure допускает 400/800/1200 Гц только до первого принятого входа. Шаг k
начинается с 1 и передаёт `floor(k*1000000/hz)` микросекунд; максимальное
число шагов 9007199254. Младшее слово последовательности оборачивается по 2^32,
у завершённых тиков есть старшее слово. Смена epoch/частоты требует новой
холодной сессии прошивки/физики.

40 значений f64 датчиков начинаются с байта 64: широта/долгота в градусах,
высота MSL в метрах (индексы 0..2); скорость NED м/с (3..5); удельная сила
акселерометра FRD м/с^2 (6..8); гироскоп FRD рад/с (9..11); единичный
кватернион корпус-to-NED wxyz (12..15); магнитное поле FRD в гауссах
(16..18); эквивалентная воздушная скорость м/с (19); батарея В/А (20..21);
неотрицательная высота AGL м (22); двенадцать RC-входов [0,1] (23..34);
ветер NED м/с (35..37); точный нулевой резерв (38..39). Значения конечны,
модуль <=1e9. Пределы широты/долготы 90/180 градусов, модуль высоты <=100000 м,
квадрат нормы кватерниона отличается от 1 не более чем на 1e-6; воздушная
скорость/батарея/ток/высота неотрицательны. Байты 384..511, 640..767 и 896..1023
нулевые. С байта 512 идут 32 u32 PWM в микросекундах. С байта 768 — шестнадцать
f64 диагностики: гироскоп град/с[3], магнитное поле миллигаусс[3], углы Эйлера
roll/pitch/yaw в градусах[3], удельная сила[3], скорость NED[3] и последний
принятый timestamp us. Это диагностика привязки, не здоровье оценивателя или
допуск полёта.

Состояния: 0 начальное, 1 опубликован запрос актуаторов, 2 опубликован полный
вход датчиков, 3 запрос остановки, 4 остановлен, 5 ошибка входа. Прошивка
владеет выходами актуаторов/диагностики и публикует 1 после атомарных записей.
Хост читает целостный запрос, публикует полный следующий вход датчиков,
записывает 2 и пробуждает futex состояния WASM (нативные проверки используют
условную переменную). Ожидание ожидаемого состояния исключает потерю пробуждения
без захвата хостом занятого pthread mutex. До изменения выхода/времени
прошивка проверяет идентичность, настроенные epoch/частоту, последовательность,
время, резерв, числа и значения датчиков. Код 1 фиксирует неверный вход.
Отсутствующий вход означает паузу: native-поток спит без продвижения времени.
Stop пробуждает поток, тот подтверждает остановку и спит до завершения
владельцем. Ошибочный поток тоже остановлен до disposal. В Main браузера нет
активного ожидания или Atomics.wait.

`WasmHalPort` холодно проверяет указатель/выравнивание/память/ABI и карту моторов;
`readActuatorsInto` пишет повторно используемый ActuatorFrameV2 следующего тика,
выбирая 1..16 каналов прошивки с индексами от нуля и явными границами PWM.
PWM 0 означает отсутствие выхода, ненулевой PWM поддерживается в 800..2200 us.
Нормализация ограничивает настроенный диапазон газа; Armed приходит от прошивки.
`submit()` проверяет приватные значения до публикации разделяемых байтов.
Замена памяти, чужие epoch/последовательность/число и ошибки прошивки закрывают
допуск. `WasmSitlSession` повторно использует проверенный glue TASK-045, владение
Worker, serial-транспорт, блокировку профиля и EEPROM через холодный callback.
Явный `checkpoint()` использует этот контракт хранилища; disposal останавливает
HAL и завершает свои pthread без обещания неявного финального сохранения.

`WasmSitlCoupling` продвигает конфигурируемую физику ровно раз на запрос прошивки
с её реальным кадром актуаторов. Истина корпуса преобразуется существующими
идеальными IMU/магнитными/воздушными наблюдениями и касательной рамой WGS84.
Вызывающий задаёт широту/долготу начала, высоту MSL, постоянную поправку геоида
и магнитное поле. Нулевая поправка геоида — явно синтетический выбор. Давление
воздушной скорости преобразуется в EAS с опорной плотностью 1.225 кг/м^3.
Ток батареи нулевой, если электрическая модель его не поставляет. Первая
интеграционная фикстура — жёсткий свободный полёт NACA6409/NeuralFoil; флаги
применимости видимы, опора на землю и обученный полёт не фабрикуются. Новая epoch
пересоздаёт владельцев прошивки и физики.

`node scripts/check-ardupilot-hal.mjs` проверяет миллион шагов native-пиров на
400/800/1200 Гц и реальное pthread-WASM ядро HAL с JS-адаптером на 800 Гц,
положительные контроли аллокатора/GC и стабильность памяти. Изолированный стенд
ядра явно не заменяет прошивку и не сертифицирует аллокации всей ArduPilot.
Браузерным тестам нужен реальный локальный HAL-артефакт через
`MIRAGE_HAL_ARTIFACT_DIR`; проверяются обмен полной прошивки, пауза, точное время,
disposal и связь с корпусом NACA6409. Приёмку сопровождают хеши исходников и
артефактов. Эти проверки не включают READY, не допускают измеренную аэродинамику,
не решают распространение прошивки и не заменяют native/WASM паритет полёта
TASK-047. Главное приложение сохраняет отдельно выбранный backend до допуска
этого режима.

Браузерный HAL управляет AGL вместе со временем: upstream `set_height_agl()`
пропускается на этом пути, сохраняя переданные высоту и дальности. Внутренняя
модель самолёта сохраняет прежний расчёт AGL по рельефу.

Завершение прошивки дожидается checkpoint, закрывает хранилище EEPROM и
завершает освобождение блокировки профиля, пока все pthread ещё существуют.
Завершение потоков — последняя синхронная фаза: снять callback, остановить
потоки, очистить владение, затем подтвердить остановку и закрыть Worker-владелец
в том же обороте цикла событий. После завершения первого потока нет await.
Флаг завершённой сессии запрещает позднее создание pthread. Блокировка профиля
защищает фиксацию хранилища; после завершения сессии вызовы serial/stepping/checkpoint
не допускаются. Браузерный fixture задержанного освобождения использует реальную
прошивку и Web Locks, проверяя, что завершение каждого из четырёх pthread идёт
после полного освобождения и что после каждого из трёх перезапусков Worker не
остаются. Прошивка не заменяется синтетическим участником, а таймаут очистки
не ослабляется.

## Паритет native/browser автопилота и допуск (TASK-047)

Локальный стенд паритета сравнивает закреплённый native-бэкенд ArduCopter JSON
с реальной HAL-прошивкой pthread-WASM в изолированном Chromium. Оба используют
одинаковый Rust BET-модуль тела/роторов, поляру NeuralFoil NACA6409,
синтетическую геометрию quad-X, явные байты параметров, начало координат и
расписание по тикам. Проверяется программное поведение объявленной
конфигурации, а не измеренная достоверность аппарата или допуск любых конфигураций.

`tests/support/autopilot-parity.ts` задаёт настраиваемый quad массой 1.5 кг,
плечами 0.2 м, диагональю инерции [0.03,0.03,0.05] кг м^2, четырьмя
двухлопастными роторами радиусом 0.15 м в порядке прошивки FR/RL/FL/RR и
максимальным моментом вала 0.15 Н м на ротор. Fixture моделирует две равномерные
лопасти по 1 г на роторе в пределах 0.045..0.15 м; инерция вала равна
2*0.001*(0.15^2+0.15*0.045+0.045^2)/3 кг м^2. Общий rotor-fixture с инерцией
0.0002 кг м^2 вызвал неустойчивость управления; неуспешная диагностика
сохранена. Новая объявленная конфигурация одинакова для обоих бэкендов;
пороги паритета для неё не менялись.

`BetFlightConfiguration.syntheticGroundDownM` необязателен и конечен. Тело,
проникшее в эту синтетическую горизонтальную площадку, проецируется на её NED
down с нулевыми скоростями/угловыми скоростями, исходной ориентацией и нулевым
инерциальным ускорением. Эта явно неупругая опора с бесконечным трением не
действует над плоскостью и отделена от Rapier и измеренной точности шасси.
Существующие конфигурации без неё сохраняют свободный полёт. Флаги валидности
NeuralFoil/ротора остаются записанными, включая низкую достоверность и выход
из диапазона при раскрутке/посадке; паритет автопилота не превращает их в PASS
измеренной достоверности модели.

Общее начало координат: -35.362938/149.165085 градусов, 584 м MSL, с явно
синтетическим нулевым смещением геоида. Магнитное поле браузера берётся из
закреплённой таблицы pymavlink/AP_Declination в этой точке; native JSON вычисляет
его по той же таблице и координатам. Датчики хоста идеальны и не имеют
случайного потока. Свежие процессы прошивки используют исходный RNG seed 1;
native libc и WASM libc не обязаны выдавать одинаковые последовательности
шума. Хеши исходников сохраняют реализации датчиков и геодезии. Эталон
не обещает побитовую эквивалентность прошивок.

`BrowserWasmConfiguration` необязательно задаёт ограниченный числовой текст
параметров и home до запуска main прошивки. Частный файл defaults записывается
в MEMFS, добавляются явные аргументы `--defaults`/`--home`. Прежние вызовы boot
сохраняют defaults/хранилище. Оба прогона сохраняют `ARMING_CHECK=1` и EKF3;
команды arming никогда не используют force-параметр. При 800 Гц GUIDED
запрашивается на 60 с, arm на 63 с, takeoff до 5 м на 70 с. На 90 с штатный
случай посылает LAND; failsafe-случай прекращает GCS HEARTBEAT, сохраняя запросы
телеметрии, при FS_GCS_ENABLE=5. Исходный STATUSTEXT должен подтвердить GCS
failsafe. Оба аппарата должны сесть и разоружиться до 120 с.

Независимый `scripts/sitl/check-parity-wire.py` использует pymavlink 2.4.50
для декодирования исходных serial-чанков и переданных команд. Печатный текст
запуска UART сохраняется отдельно при предполётном прогреве; ошибки CRC
остаются отказами. Mode/armed/флаги EKF и все пять innovation ratios каждого
оцениваемого отсчёта должны совпадать с исходными сообщениями и временем
приёма; допускается лишь один тик учёта производителя. `MavParser` полностью
потребляет структурно корректный неподдерживаемый конверт, не ища 0xfd в его
payload; неизвестные payload не допускаются. Повреждённые известные кадры
сохраняют ограниченную ресинхронизацию. Регрессия воспроизводит прежнюю ошибку
свежести при задержке EKF; захваты до исправления проваливают независимый аудит
и исключаются из приёмки.

`docs/validation/autopilot-parity.schema.json` описывает вход сравнения.
Оцениваемый эталон: абсолютные тики 72000..96000 включительно (90..120 с),
шаг 8, 3001 отсчёт при 100 Гц. Выравнивание/интерполяция траекторий, вычитание
среднего и создание golden запрещены. Position RMSE использует евклидово
расстояние NED; attitude RMSE — кратчайший геодезический угол кватернионов в
градусах с нормализацией в проверенном диапазоне единичной нормы и
эквивалентностью q/-q. Фиксированные пределы: 0.5 м и 2 градуса за 30 с.
Непрерывное расхождение mode/arming допускается максимум 0.5 с. Каждый отсчёт
требует возраста heartbeat/EKF <=1 с, сырых флагов EKF с битами 55 и без флага
неинициализированного фильтра, конечных innovation ratios в [0,1). Неполные,
сдвинутые, дублированные захваты или разные входы отклоняются до расчёта.

`scripts/assemble-autopilot-parity.mjs` связывает захваты/аудиты в два bundle.
`scripts/compare-autopilot.mjs` перепроверяет исходные файлы, хеши аудита/
исходников/физики, байты параметров и точные отсчёты перед выдачей
`evidenceValidated`. Вызов без входа завершает работу с кодом 2
(BLOCKED_EXTERNAL), неверные/проваленные данные — с кодом 1, проверенный
численный PASS — с кодом 0. Отчёты связывают хеши прошивок native/WASM,
аппарат, параметры, команды, датчики, seed и частоту. Сырые файлы и прошивка
остаются локальными; изменение исходников/сборки аннулирует приёмку.

`admitWasmParity(bytes, trustedReportSha256, activeIdentity)` на холодном пути
проверяет хеш отчёта, идентичности, фиксированные пределы и оба успешных
сценария, выдавая замороженную capability в памяти. Ожидаемый хеш берётся из
доверенной локальной конфигурации приёмки, а не из загруженного отчёта.
Выданная capability и совпадающая текущая идентичность обязательны для
`AutopilotSession.connect('wasm-sitl', epoch, nowMs, capability, identity)`.
Копии/сериализованные capability, неуспешные отчёты и изменённые конфигурации
отклоняются. Подключение переводит лишь в initializing; живой прогрев/здоровье
и свежесть актуаторов по-прежнему необходимы. Низкоуровневый HAL-стенд служит
диагностике и не выдаёт эту capability жизненного цикла. Выбор бэкенда приложения,
квалификация аллокатора всей прошивки, распространение GPL и выпускные гейты
отделены; активное приложение сохраняет бэкенд demo.

## Манифест аппарата v2 и профиль ArduPilot (TASK-087)

`packages/physics/src/vehicle.schema.json` и `vehicle-manifest.ts` задают
`schemaVersion: 2`. Вход поступает как `unknown` и проходит схему AJV в
строгом режиме (`strictNumbers`, объединённые типы только для допускающих
`null` разделов, дискриминаторы `kind`). Затем выполняются физические и
перекрёстные проверки, и возвращается глубоко замороженный снимок. Единицы,
системы координат и порядок кватерниона те же, что в v1 (SI, мировая NED,
связанная FRD, wxyz). Каждая позиция `*BodyM` отсчитывается от опорной точки
корпуса; ЦМ задаётся `massProperties.cgOffsetBodyM`, тензор инерции берётся
относительно ЦМ в осях корпуса. Все ключи верхнего уровня обязательны:
отсутствующий раздел записывается явным `null` или `[]` и никогда не
подставляется по умолчанию. Минимальный корректный манифест описывает корпус
без роторов:

```json
{
  "schemaVersion": 2, "modelId": 2, "kind": "demo",
  "units": "SI", "worldFrame": "NED", "bodyFrame": "FRD", "quaternionOrder": "wxyz",
  "datasets": [{ "id": "airframe", "kind": "synthetic", "sourceSha256": null,
    "derivation": "Hand-specified example body." }],
  "provenance": { "massProperties": "airframe", "rotors": null, "motors": null, "escs": null,
    "battery": null, "airframeDrag": null, "controlSurfaces": null, "landingGear": null,
    "sensorMounts": null, "rotorWakePairs": null },
  "massProperties": { "massKg": 1.5, "cgOffsetBodyM": [0.01, 0, 0.03],
    "inertiaCgKgM2": [0.03, 0, -0.001, 0, 0.032, 0, -0.001, 0, 0.05] },
  "rotorCount": 0, "rotorCapacity": 32, "rotors": [],
  "motors": [], "escs": [], "battery": null, "airframe": { "drag": null },
  "controlSurfaces": [], "landingGear": [], "sensorMounts": [], "rotorWakePairs": [],
  "ardupilot": null
}
```

| Раздел | Поля | Проверки сверх схемы | Потребитель в рантайме |
|---|---|---|---|
| `datasets` (1–32) | `id`; `synthetic`: `sourceSha256` (hex или `null`), `derivation`; `measured`: `sourceSha256`, `license`, `acquiredAt` (UTC `YYYY-MM-DDThh:mm:ssZ`), `reference` | уникальные ID, разбираемое время, ссылка на каждый набор данных | — |
| `provenance` | один ID набора данных или `null` на раздел | не `null` ровно тогда, когда в разделе есть данные; известные ID | — |
| `massProperties` | `massKg` > 0, `cgOffsetBodyM`, `inertiaCgKgM2` | точная симметрия, положительная определённость по Холецкому, неравенство треугольника твёрдого тела | рантайм v1 (TASK-033) |
| `rotors` (≤32) | `RotorGeometry` из v1 без изменений; тест требует совпадения схемы с v1 | проверки v1: уникальные ID и каналы, единичные кватернионы втулки (1e-6), станции, ширины квадратуры | рантайм v1 |
| `motors` (≤32) | `id`, `rotorId`, `kvRpmPerV`, `resistanceOhm`, `currentLimitA` (нативный `Motor`) | уникальные ID, известный ротор, один двигатель на ротор | TASK-092 |
| `escs` (≤32) | `id`, `motorId`, целые `pwmMinUs`/`pwmMaxUs` в [800, 2200], `commandTauS` | размах ≥100 мкс (граница `ExternalSitl`), известный двигатель, один ESC на двигатель | ШИМ через профиль; запаздывание TASK-092 |
| `battery` | `openCircuitFullV`, `openCircuitEmptyV`, `internalResistanceOhm` ≥0, `capacityAh`, `currentLimitA` (нативный `Battery`, заряд 3600·А·ч Кл) | полное ≥ пустого | TASK-092 |
| `airframe.drag` | `dragAreaBodyM2` (тензор C_D·A, м²), `centerOfPressureBodyM` | симметричный положительно определённый, так что сопротивление всегда диссипативно | TASK-096 |
| `controlSurfaces` (≤16) | `id`, `function`, `actuatorChannel`, пределы отклонения в ±π/2, `rateLimitRadS` | уникальные ID и каналы, не канал ротора, min < max | TASK-109 |
| `landingGear` (≤8) | поля `ContactWheel` плюс `id`; точка крепления от опорной точки | уникальные ID, обод < шины, последний узел кривой шины ≥ шина − обод; законы стойки и шины остаются нативными | TASK-095 |
| `sensorMounts` (≤32) | `sensor`, `instance` (0–7), `positionBodyM`, `sensorToBody` | уникальные пары датчик/экземпляр, норма кватерниона в пределах 1e-6 | TASK-114 |
| `rotorWakePairs` (≤64) | `upstreamRotorId`, `downstreamRotorId` | известные роторы, без пар с самим собой и повторов, ацикличность | TASK-101 |
| `ardupilot` | `vehicle: "copter"`, `frameClass`, `frameType` | допускается только 1/1 (quad X) с проверкой геометрии ниже | профиль параметров |

Проверка инерции следует из J = ∫(|r|²·1 − r·rᵀ) dm: каждый главный момент не
больше суммы двух других, равенство достигается для плоского тела. Допуск
1e-12·след покрывает только округление решателя собственных значений.
Ёмкости совпадают с существующими интерфейсами: 32 ротора (v1), 8 слотов
колёс (contact ABI v2), 16 управляющих поверхностей и 32 канала актуаторов.

Объявленная рама quad X сверяется с аппаратом паритета TASK-047, на котором
летал ArduCopter. Каналы актуаторов 0–3 соответствуют FR, RL, FL и RR. Знаки
квадрантов втулок относительно ЦМ (x, y) равны (+,+), (−,−), (+,−) и (−,+),
и ни одна втулка не может лежать в плоскости ЦМ. Ось тяги втулки +z_h должна
отклоняться от направления вверх корпуса не более чем на 45°. Ось вращения
s·R(q_hb)·ẑ должна быть направлена вверх (против часовой стрелки при взгляде
сверху) для каналов 0–1 и вниз для каналов 2–3. Другие классы и типы рамы не
имеют доказательств в репозитории и отклоняются.

`deriveVehicle` возвращает главные моменты по возрастанию и правую матрицу
единичных главных осей. Используются циклические вращения Якоби (Golub и
Van Loan, алгоритм 8.5.3), не более 50 проходов; после четырёх проходов
элементы ниже точности диагонали обнуляются. Для вырожденных моментов
главные оси не единственны. Два аналитических эталона выполняются с
относительной точностью 1e-12: блок x–z тензора фикстуры и повёрнутый
диагональный тензор. `deriveVehicle` также возвращает позиции втулок, шасси
и датчиков относительно ЦМ и моментную постоянную двигателя:

\[
k_t = k_e = \frac{60}{2\pi \cdot KV}
\]

`migrateModelManifestV1(input, dataset)` проверяет манифест v1 и делает ЦМ
опорной точкой (нулевое смещение). Масса, инерция и роторы копируются без
изменений, а происхождение назначается таким, каким его указал вызывающий.
Тензор v1, нарушающий неравенство треугольника, отклоняется, а не
исправляется. `projectVehicleToModelV1` возвращает отсчитанный от ЦМ
дескриптор v1 (втулка минус ЦМ), который используют `FrameLayout` и
`BetFlightDynamics`. При любых данных двигателей, ESC, батареи,
сопротивления, поверхностей, шасси, креплений датчиков, пар следа или рамы
ArduPilot он отказывает, называя задачу-владельца. Демо-квадрокоптер,
наклонный октокоптер и базовый квадрокоптер паритета проходят туда и обратно
точно.

`ardupilotParameterProfile({ sha256, manifest })` (профиль v1) требует
допущенную раму и двигатель с ESC для каждого ротора с одним общим диапазоном
ШИМ. Он выводит две строки комментария и затем строки `NAME value`,
отсортированные по имени, с концами строк LF и завершающим переводом строки:

```text
# MirageSITL ArduPilot parameter profile v1
# modelId 87; manifest sha256 <64 lowercase hex>
FRAME_CLASS 1
FRAME_TYPE 1
MOT_BAT_VOLT_MAX 0
MOT_BAT_VOLT_MIN 0
MOT_PWM_MAX 2000
MOT_PWM_MIN 1000
```

Профиль выводит только имена параметров, встречающиеся в
`scripts/sitl/driver.mjs`, `scripts/prepare-autopilot-parity.mjs` или
`packages/autopilot/src/external-sitl.ts`; это проверяет тест. Компенсация
напряжения остаётся отключённой (`MOT_BAT_VOLT_* 0`), как в настройках
паритета TASK-047, пока TASK-092 не начнёт передавать напряжение батареи.
Имена `MOT_THST_EXPO`, `BATT_*`, `INS_POS*` и `SIM_*` ждут этих доказательств
или каталога из закреплённых исходников TASK-089.

`VehicleRegistry` хеширует точные байты содержимого (≤1 МиБ, строгий UTF-8)
и допускает схемы 1 и 2. ID модели с другим хешем считается коллизией.
`PhysicsSessionV2` принимает необязательный `SessionModelPort` пятым
аргументом конструктора; без него `model.load` отклоняется с `ASSET_MISSING`,
как и раньше, так что бэкенд demo по умолчанию не меняется.
`registryModelPort(registry, build)` требует зарегистрированный ID, хеш,
равный зарегистрированному (запрос может использовать hex в верхнем
регистре), и успешную проекцию. Подготовленная динамика должна сообщать ID
загружаемой модели. Фиксация освобождает прежнюю динамику и сохраняет
фабрику, так что `sim.configure` пересобирает загруженную модель на новой
частоте. Неудачная загрузка сохраняет активную модель и эпоху.

Открытые пункты:

* Нативный драйвер SITL по-прежнему пишет фиксированный `quad.parm`.
  Генерация этого файла из манифеста меняет идентичность исходника драйвера,
  поэтому записи TASK-042/043/059 пришлось бы получить заново.
* Ни один путь приложения не регистрирует модели.
* Привязки поляр и параметры роторов на время выполнения остаются в
  `BetFlightConfiguration`.

## Конвейер доказательств точности (TASK-090)

`packages/physics/src/fidelity-metrics.ts` и `bench-import.ts` — офлайн-код
для доказательств. Он выделяет память и никогда не вызывается из
физического шага.

`timeDomainMetrics(measured, simulated)` сравнивает два ряда равной длины с
одинаковой дискретизацией. Он возвращает среднеквадратичную ошибку, смещение
(среднее разности «моделирование минус измерение») и коэффициент
неравенства Тейла U. U лежит в [0, 1], равен 0 при полном совпадении и
отклоняется как неопределённый, если оба ряда целиком нулевые:

\[
U = \frac{\sqrt{\frac{1}{n}\sum_i (s_i - m_i)^2}}{\sqrt{\frac{1}{n}\sum_i s_i^2} + \sqrt{\frac{1}{n}\sum_i m_i^2}}
\]

`welchFrequencyResponse(input, output, fs, N, overlap, window)` усредняет
K ≥ 2 сегментов длины N, равной степени двойки в [16, 65536]. Один сегмент
дал бы γ² = 1 тождественно. Из каждого сегмента вычитается среднее, затем он
умножается на периодическое окно Ханна или прямоугольное окно. БПФ по
основанию 2 использует X_k = Σ x_n·e^(−j2πkn/N), а односторонние бины
k = 1..N/2 лежат на частотах f_k = k·fs/N. Масштабные множители окна
сокращаются в обоих отношениях:

\[
\hat H(f_k) = \frac{\sum_s X_s^*(f_k)\,Y_s(f_k)}{\sum_s |X_s(f_k)|^2},\qquad
\hat\gamma^2(f_k) = \frac{\left|\sum_s X_s^* Y_s\right|^2}{\sum_s |X_s|^2 \sum_s |Y_s|^2}
\]

Бин, мощность входа в котором не превышает 1e-20 от самого сильного бина,
считается невозбуждённым: его H равна NaN, а γ² равна 0. Бин БПФ в f64 несёт
около 1e-32 мощности округления, поэтому этот порог на двенадцать порядков
выше округления и на 200 дБ ниже самого сильного бина.

`frequencyResponseCost(reference, model, { bandHz, points, minCoherence })`
вычисляет стоимость в стиле CIFER:

\[
J = \frac{20}{n}\sum_{i=1}^{n} W_\gamma(f_i)\left[W_g\,(\Delta|H|_{dB})^2 + W_p\,(\Delta\angle H_{deg})^2\right],\qquad
W_\gamma = \left[1.58\left(1 - e^{-\gamma^2}\right)\right]^2
\]

Стоимость использует W_g = 1 и W_p = 0.01745, так что 1 дБ весит столько же,
сколько 7.57°. `points` целевых частот распределены по полосе логарифмически,
и каждая отображается в ближайший бин; бин, общий для нескольких целей,
учитывается один раз. W_γ использует опорную (измеренную) когерентность.
Точки с γ² ниже `minCoherence` исключаются, а n считает оставшиеся точки.
Разности фаз приводятся к (−180°, 180°], поэтому постоянное расхождение даёт
одинаковое J при любом n. Ориентиры: J ≤ 100 для принятой модели, J ≤ 50 для
модели, почти неотличимой от полёта, и γ² ≥ 0.6 для пригодных точек.

Источники: веса, W_γ, ориентиры для J и порог когерентности приведены по
Ågren et al., «In-flight System Identification of the Ingenuity Mars
Helicopter» (NASA Ames, AIAA 2025), и по ретроспективе идентификации систем
DLR (Journal of Aircraft, doi 10.2514/1.C037262). Нормировка 20/n и
логарифмическое распределение точек следуют Tischler и Remple, Aircraft and
Rotorcraft System Identification, 2-е изд. (AIAA, 2012).

Bench CSV v1 описывает статический стенд тяги:

```text
mirage-bench-csv,1
diameterM,0.254
rpm,thrustN,torqueNm,airDensityKgM3
2000,0.610472757547,0.0100957820214,1.2
```

`importBenchCsv` принимает LF или CRLF и 1–10000 строк. Числа должны быть
строгими десятичными (без `+`, hex, `Infinity` и пустых полей). Диаметр
должен лежать в (0, 10] м, rpm > 0, а плотность — в [0.05, 2] кг/м³, это
диапазон `atmosphereFromState`. Строки сохраняют порядок файла. При
n = rpm/60:

\[
C_T = \frac{T}{\rho n^2 D^4},\qquad C_Q = \frac{Q}{\rho n^2 D^5},\qquad C_P = 2\pi C_Q,\qquad
\mathrm{FM} = \sqrt{\frac{2}{\pi}}\,\frac{C_T^{3/2}}{C_P}
\]

Импорт также приводит тягу и момент к плотности ISA на уровне моря
(1.2250 кг/м³ из `isaTroposphere(0)`). Он помечает отрицательную тягу,
отрицательный момент и FM > 1, поскольку импульсная теория ограничивает
статическую тягу в свободном воздухе на единицу мощности. Помеченные строки
сохраняются.

Схема захвата v1 имеет такой каркас; каждый ряд должен содержать 2..2^20
конечных отсчётов:

```json
{
  "schemaVersion": 1, "kind": "mirage-fidelity-capture",
  "provenance": { "source": "flight-test", "operator": "<name>", "recordedAt": "2026-10-26T00:00:00Z",
    "firmwareSha256": "<64 hex>", "modelSha256": "<64 hex>" },
  "timeDomain": [{ "id": "roll-rate", "unit": "rad/s", "sampleRateHz": 100,
    "measured": ["<samples>"], "simulated": ["<samples>"],
    "limits": { "maxRms": 0.02, "maxAbsBias": 0.02, "maxTheil": 0.05 } }],
  "frequencyResponse": [{ "id": "roll-rate-response", "sampleRateHz": 100, "segmentLength": 64,
    "overlap": 0, "window": "rectangular", "bandHz": [1.5625, 46.875], "points": 20,
    "minCoherence": 0.6, "maxCost": 100,
    "measuredInput": ["<samples>"], "measuredOutput": ["<samples>"],
    "simulatedInput": ["<samples>"], "simulatedOutput": ["<samples>"] }],
  "bench": { "csv": "<bench CSV v1 text>", "csvSha256": "<64 hex>",
    "predicted": [{ "rpm": 2000, "ct": 0.1122, "cp": 0.04365 }],
    "limits": { "maxCtRelativeError": 0.05, "maxCpRelativeError": 0.05 } }
}
```

Моделируемые ряды получают повторным воспроизведением измеренного
возбуждения: те же отсчёты во временной области и тот же введённый вход для
частотных характеристик. Предсказания стенда содержат по одной строке на
каждую измеренную строку с тем же rpm.

`node scripts/check-fidelity.mjs --input CAPTURE.json --sha256 HEX` построен
на `scripts/validation/evidence.mjs`, который проверяет хеш и бюджет размера
32 МиБ. Он требует точного набора ключей везде, уникальных ID разделов, не
более 32 разделов каждого вида и хотя бы одного раздела в сумме. Объявленные
пределы могут быть строже ориентиров, но никогда не мягче: maxCost ≤ 100,
minCoherence ≥ 0.6, maxTheil ≤ 1 и относительные ошибки стенда ≤ 1. Строка
стенда с любым флагом согласованности проваливает сравнение стенда.

Коды выхода:

* Без входа — BLOCKED_EXTERNAL (2).
* Неверный, нехешированный или слишком мягкий вход — FAIL (1).
* Происхождение `synthetic` даёт BLOCKED_EXTERNAL (2) с вычисленными
  метриками и `limitsMet`; это никогда не PASS.
* Происхождение `flight-test` с ненулевыми хешами прошивки и модели даёт
  PASS (0) или FAIL (1).

Отчёт `test-results/validation/fidelity.json` (схема 1, вид `fidelity`)
записывает хеш входа, ревизию git и хеш валидатора. Аналитическая фикстура
`tests/fixtures/validation/fidelity-synthetic-capture.json` сообщает
J = 19.950 = 20·W_γ(1) для своей ошибки модели +1 дБ и завершается с кодом 2.

Открытые пункты:

* Оценить реальный полётный захват ArduCopter SYSTEMID и реальный файл
  стенда тяги (G4).
* Преобразовывать журналы DataFlash в захват v1.
* Построить повторное воспроизведение моделирования, которое создаёт
  моделируемые ряды.
