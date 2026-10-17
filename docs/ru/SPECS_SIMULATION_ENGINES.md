# SPECS_SIMULATION_ENGINES.md

<!-- source-sha256: 914877eaaa681e6d5c9350de6fb615238e2b5620a1e2158ed495386b8172a08c -->

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
* Экспериментальная сверка rotor/airframe и реальный HITL — отдельные gates:
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

Rapier 0.21.0 выбран для эталона контакта сферы с плоскостью. Он владеет
интегрированием, использует NED +Down и оценивает суммарный контактный импульс
по изменению количества движения за вычетом импульса внешних сил и гравитации.
`pointBody` — номинальная нижняя точка сферы в осях тела, а не общий многоточечный
контакт шасси. Проверки падения, трения и восстановления используют настоящий
WASM-движок. Катящаяся сфера при кулоновском трении может сохранять поступательную
скорость; нельзя добавлять вымышленную силу остановки. Getter-методы провайдера
создают новые векторы/кватернионы на каждом шаге: `highRateCertified=false`.
TASK-029 остаётся BLOCKED_DECISION до появления привязки без аллокаций или
другого решателя, проходящего G1. Прототип нельзя выбирать в production Worker
как сертифицированный backend 400–1200 Гц.

JSBSim v1.2.3 зафиксирован на коммите
`570e8115a102df8f877b11e0e59b964ea483e3c0`; Emscripten 4.0.15 — на коммите emsdk
`389a68bc35dcff7ebae4614e1615099dafda00d1`. Перед сборкой проверяются HEAD,
чистота отслеживаемых файлов, хеш LGPL-2.1 библиотеки и хеш манифеста SDK.
XML самолёта не поставляется: c172x содержит отдельные ограничения распространения
и не валидирован пилотами. Перед упаковкой требуется проверка лицензии и данных
каждой модели. Нативный smoke использует тот же bridge/исходники, выдаёт 22 конечных
SI double через одну секунду симуляции и **не** проверяет балансировку, паритет
native/WASM или аллокации. Установка SDK отклонена proxy CONNECT 403 для
storage.googleapis.com; TASK-030/031 остаются BLOCKED_EXTERNAL. Сетевая настройка
сохранена как черновик и не доказывает доступность SDK в текущей или новой среде.

ABI bridge v1 принимает четыре float64: газ [0,1], элерон/руль высоты/руль
направления [-1,1]. Выход — 22 double: позиция NED фиксированного начала 0..2,
скорость NED 3..5, wxyz тела относительно исходной NED 6..9, угловая скорость
тела 10..12, удельная сила тела 13..15, секунды симуляции 16, высота ASL в метрах
17, модуль гравитации 18, координатное ускорение NED 19..21. Коэффициент футов —
точно 0.3048. Исходные ECEF и поворот в NED фиксируются при инициализации;
векторы тела преобразуются через ECEF в эту исходную систему. Извлечение
кватерниона учитывает пассивную матрицу JSBSim. Координатное ускорение включает
перенос скорости тела; удельная сила — ускорение приложенных сил. JSBSim владеет
интегрированием; контактные импульсы, закреплённые trim/step-эталоны, счётчик
WASM-аллокаций и загрузка артефакта в Worker пока не проверены.

`node scripts/validate-models.mjs` собирает настоящие scalar/SIMD-артефакты,
запускает два случая движения тела на 10 секунд при 400/800/1200 против 4800 Гц,
проверяет аналитическую баллистику и сохраняет SHA-256/происхождение и ошибки в
`test-results/validation/model-report.json`. Допуск позиции 0.1 м; ориентации
0.5 градуса по модулю скалярного произведения кватернионов. Numerical PASS
отделён от fidelity: отсутствие измерений, полной привязки BET, контакта G1 и
паритета JSBSim сохраняет общий BLOCKED (код 2). Синтетика не объявляется
измерениями. Схема: `docs/validation/model-report.schema.json`.

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


## Повторная проверка и исправленные контракты: TASK-029–031, TASK-033

Прежняя диагностика аллокаций только по getter была неполной. Rapier 0.21.0
поддерживает готовые объекты для позиции, ориентации, линейной и угловой скорости.
`GroundContact` теперь передаёт их, сохраняет нативные векторы силы/момента/
гравитации до dispose и вызывает raw pipeline. Этот путь ограничен неизменной
топологией твёрдых тел: без hooks, событий, разрыва мягких тел и автоматической
регистрации новых тел/collider. Сохраняется один владелец интегрирования.
`VectorOps.intoRaw` не вызывается на шаге; dispose идемпотентен, последующие шаги
отклоняются. Это убирает явное создание обёрток, но не доказывает G1 движка.

`node scripts/bench-contact.mjs` измеряет три миллиона прогретых JS-шагов и
положительный контроль. Каждые 800 тиков 100 тиков к сфере массой 1 кг приложены
-19.6133 N, затем 700 тиков сила снята; проверяются взлёты и посадки на плоскость.
Переходы контакта считаются по отрицательному нормальному импульсу вблизи плоскости.
Профилирование выявило импортированные таймеры `performance.now` Rapier и упаковку
чисел в getter. Отключение runtime-флага profiler не удаляет все таймеры. Во всех
трёх окнах остаётся GC: **G1 не пройден**. Нельзя подменять глобальные часы или
подавлять наблюдение GC для сокрытия провала.

Официальные исходники: коммит
`b716d375efc0201003f0cd9ef7168eee0b62c177` (нативный Rapier 0.36.0, JS 0.21.0).
`node scripts/check-contact-native.mjs` проверяет коммит/лицензию, копирует
версионированные probe и lock зависимостей во внешний кеш сборки, выполняет
1e6 шагов f64 с dim3/std/enhanced-determinism **без** feature profiler.
Счётчик аллокатора с положительным контролем обнаруживает 1,688,500 аллокаций /
77,328,000 байт. Отчёт: `test-results/bench/contact-native.json`. Это нативный
эталон f64, а не измерение аллокатора поставляемого f32 WASM. Одного удаления
JS-таймеров недостаточно для сертификации замены f64. TASK-029 требует сборку/
привязку движка без аллокаций до допуска.

### Непрозрачные handles JSBSim и холодная балансировка

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
положительный контроль обязателен. Результат: 21,142,500 аллокаций /
1,454,820,000 байт; **нативный G1 не пройден**, CLI возвращает 2.
`test-results/validation/jsbsim-native.json` сохраняет хеши модели/исходников/
bridge/checker, окна и отдельный статус WASM. XML самолёта не распространяется.
Загрузка SDK по-прежнему получает HTTP 403 от storage.googleapis.com; сборка WASM,
Worker smoke, паритет балансировки и контактный обмен не проверены. Нативная
балансировка не закрывает TASK-030/031.

### Модельный отчёт schema v2

`validate-models.mjs` отклоняет пустые/переставленные частоты, неверные случаи,
повторяющиеся ID, отсутствие аналитической баллистики и неподдерживаемые записи
измерений **до** компиляции. Поддерживаемый манифест явно синтетический;
измерения требуют проверенного адаптера единиц/области применимости/происхождения.
Версия отчёта — 2: добавлены `diagnostics.contact` и `diagnostics.jsbsimNative`
с путём, SHA-256 отчёта (или null) и статусом missing/invalid/stale/pass/failed.
Несовпадение хеша адаптера/bridge/checker с текущими исходниками означает stale.
Диагностика описывает доказательства и не допускает полный backend и не заменяет
WASM-паритет нативными результатами. Общий/fidelity статус остаётся BLOCKED с
кодом 2 при прохождении всех 12 численных случаев. Отсутствие измерений борта/
ротора и полной привязки BET явно сохранено. Прежние результаты пакета выше
остаются датированной историей; этот раздел заменяет прежнюю диагностику контакта.


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
npm-привязки f32 WASM и не проверка общего контакта шасси. JS-адаптер всё ещё
проваливает критерий наблюдаемого GC и сохраняет `highRateCertified=false`.

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
происхождение. Отчёт модели v2 дополнительно содержит
`diagnostics.contactNativePatched` и `diagnostics.jsbsimNativePatched` с теми же
статусами missing/invalid/stale/pass/failed; они не заменяют production-контакт
и критерии WASM.

Установка SDK всё ещё отклоняется proxy CONNECT 403 на storage.googleapis.com.
Проверить и сохранить существующий черновик сети и старта в настройках среды,
затем опубликовать/применить перед повторной установкой закреплённого Emscripten.
Сохранение черновика не применило доступ в этой среде. Всё ещё нужны настоящая
сборка JSBSim WASM, Worker smoke, паритет native/WASM, контактное сопряжение и
проверка данных модели. TASK-029 остаётся BLOCKED_DECISION до сертификации
привязки и общего контакта; TASK-030/031/033 — BLOCKED_EXTERNAL. Отсутствие
измерений ротора/борта и неподключённый полный BET backend блокируют fidelity.


## Радио, транспорт автопилота и изолированные отказы (TASK-037–060)

Этот пакет реализует TASK-037/038/039/040/048/052/053/056/057/060. Модули —
независимые протокольные, транспортные и учебные эталоны. Действующий полётный
Worker использует демо-физику. Прошивка ArduPilot, здоровье HITL, полная композиция
РЭБ, валидированный рельеф и физическая приёмка передатчика/контроллера не заявлены.
TASK-036 геодезии, TASK-041 JSON lockstep и TASK-049 HIL streaming остаются
границами будущей интеграции с настоящими свидетельствами upstream/устройства.

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
закрывает сессию. MAVLink остаётся отдельным каналом. Реальный процесс
ArduPilot SITL здесь не запускается: закреплённая нативная обвязка — TASK-042.

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
(ControlTargetV2.applyScheduled) без аллокаций. У каждого вида эффекта один
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

`EkfMonitor` принимает прошедшие CRC-проверку MAVLink2 HEARTBEAT (ID 0, CRC_EXTRA 50, длина 9) и ArduPilot EKF_STATUS_REPORT (ID 193, CRC_EXTRA 71, длина 26 с необязательной дисперсией воздушной скорости). Эталон независимо сгенерирован из ardupilotmega XML существующей закреплённой ревизии MAVLink с pymavlink 2.4.50; сохранены рекурсивные хеши XML и модуля генератора. В HEARTBEAT custom_mode — u32 со смещения 0, autopilot в байте 5 должен быть 3, mavlink_version в байте 8 — 3. Пять отношений EKF — f32 по смещениям 0/4/8/12/16; flags — u16 по смещению 20; расширение airspeed начинается с 22. Консервативный учебный допуск требует конечных неотрицательных отношений меньше 1 и отклоняет EKF_UNINITIALIZED (1024). Исходные биты 1/2/4/16/32 переходят в ABI-v2 1/2/4/8/16. Относительная горизонтальная позиция не заменяет абсолютную. Принимается только настроенная пара system/component.

Временная область — миллисекунды симуляции SITL или монотонные настенные миллисекунды HITL. Возраст heartbeat и EKF не превышает 1000 мс, будущие метки запрещены. `EkfWarmup` дополнительно требует 30 секунд симуляции, совпадения эпох, отсутствия обратного хода часов, возраста IMU <=0.01 с и GNSS <=0.3 с без будущих отсчётов. Выдаётся фактически измеренное отношение времени симуляции к настенному; настройка speed сама не ускоряет прошивку. HITL запрещает speed !=1 и опережение симуляцией настенного времени более чем на 1% плюс 0.1 с. РЭБ запрещена до прохождения допуска и снова запрещается при отказе здоровья. Это независимо проверенные модули допуска: живой прогрев, запуск прошивки и интеграция TASK-042 остаются BLOCKED_EXTERNAL, TASK-043 не DONE.

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

Приложение пишет прореженные отсчёты истины/стиков demo из Main с номинальными 10 Гц времени симуляции. Запись каждого физического тика и синхронных датчиков/актуаторов FC не заявляется. Недостающие потоки отсутствуют; пропуски интервалов записи и очереди явны. Стики опрашиваются в Main, точное совпадение входа с выбранным тиком истины не сертифицировано. Смена физической частоты останавливает запись ради корректной provenance. Хеш demo-модели — SHA-256 исходника динамики; хеш прошивки null. Полное подключение производителя высокой частоты и provenance прошивки ожидают рабочий backend.

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

`node scripts/validate-models.mjs` записывает отчёт модели по схеме v3:

* сверяет хеш фикстуры с `tests/fixtures/validation/reference-manifest.json` и
  реестром;
* сообщает `measuredValidation[]` с происхождением, девятью прогонами и
  статусом каждой проверки;
* устанавливает `contactFidelityStatus: "failed"` и общий `status: "failed"`,
  и завершается с кодом 2;
* `numericalStatus` остаётся `pass` (12 случаев);
* `fidelityStatus` остаётся `blocked`, так как данных планера или ротора нет.

Отказ G1 непропатченной JS-привязки Rapier и отсутствие наборов данных
ротора/планера по-прежнему перечислены как отдельные блокеры.

## Инструменты приёмки, collision-чанки и сценарии (2026-10-17)

Итерация реализует независимые программные части TASK-042/044/051/059/065/073/079/080/082/083. Production SITL/HITL, WASM-прошивка, измеренная аэродинамика, реальный контакт с рельефом и полная тепловая сцена не включаются. Зависимости с внешними блокировками остаются открыты.

### Форматы свидетельств и вердикты

Общие функции ограничивают вход 32 MiB, проверяют точный SHA-256, отклоняют некорректные/нечисловые поля и пишут отчёты версии 1 в test-results/validation. PASS даёт 0, FAIL — 1, BLOCKED_EXTERNAL — 2. Отсутствие входа не превращается в зелёный тест. Аппаратные/source-строки импортированного JSON — декларации для проверки оператором, а не криптографическое доказательство физического исполнения. Структурные тесты явно синтетические и не допускают аппаратные/прошивочные режимы. CLI сохраняет sourceRevision, validatorSha256 и, при наличии, inputSha256; исходные захваты нужны для аудита.

SITL фиксирует коммит прошивки 8ab6afde107a91df1b5f60ade8f333cb8a61b190, EKF3 и arming checks. Внешний доверенный драйвер получает проверенный ELF и параметры; production-драйвер не предоставлен. Анализатор требует непрерывный servoFrame от нуля, четыре PWM 1000–2000 us, возрастающее время с разрывами<=0.1 с, реальное происхождение/модель/прошивку и здоровый EKF. Стадии идут arm→takeoff→hold→land, в GUIDED=4 до LAND=9. Высота взлёта>=3 м, удержание 10 м ±1 м не менее 10 с, последний отсчёт разармирован ниже 0.5 м. Закрытый запуск ограничен 120 с/16 MiB; завершается только собственный процесс/группа. Закреплённые исходники/хеши сами не доказывают воспроизводимость бинарника. Нативная прошивка и отсутствующий драйвер замкнутого контура остаются внешними требованиями.

HITL-анализ требует 60–3600 с при 200/400 Гц с ровно duration*hz отсчётами. Для каждого sequence: scheduledUs=i*1e6/hz, sentUs>=scheduledUs и строго возрастающее actuatorUs между sentUs и sentUs+100000. Переполнения/потери запрещены; p99 опоздания<=5/2.5 мс, нужно наблюдаемое отключение актуаторов при unplug. См. физическую процедуру; CLI не открывает Serial и не армирует.

РЭБ требует контроль без отказа и jamming, position-step, velocity-drift, magnetic, motor-loss. Отсчёты сохраняют одинаковые SHA-256 истины/базы, монотонное время симуляции, реальные mode/EKF flags, инновации и позиционные ошибки. Наблюдения меняют только отказы. Диапазоны случаев должны совпадать с независимо закреплёнными значениями для конкретной прошивки/параметров; включённая матрица не имеет полученной базы, поэтому CLI заблокирован. Он не обещает конкретный fallback-режим или обход EKF gate.

GPU-анализ требует M4 или RTX4050, ОС/браузер/питание/backend, видимую production-сцену 1920x1080 DPR1, все terrain/FPV/thermal, прогрев>=60 с и измерение>=600 с. Положительные конечные интервалы кадров должны покрыть длительность с точностью 0.02 с. Пределы p99 для 60/120 FPS остаются 16.67/8.33 мс, GPU<=2 GiB и CPU-кеш<=512 MiB. Программный/headless-рендеринг не проходит. Демо не предоставляет producer измерений полной production-сцены и целевые устройства; импортированные трассы требуют проверки исходного профилировщика.

Системные свидетельства сопоставляют точные G0/G1/G2/G3/G4 ID режимам demo, external-sitl, wasm-sitl и hitl. Отсутствующее требование — NOT_RUN; любой FAIL проваливает режим; иначе неполное покрытие блокирует. PASS требует observed source, ожидаемый путь отчёта, точный хеш, совпадающую ревизию и исходный PASS правильного вида. Пустые, повторные, неизвестные и устаревшие декларации режим не сертифицируют. Старые численные отчёты не превращаются молча в физический PASS. Инвентарь выпуска проверяет собственные generated-файлы, пределы байтов, хеши, лицензии и фактические метаданные; полная проверка лицензий/сборки/чистой машины/исходных свидетельств остаётся заблокирована. Скрипты выпуска ничего не публикуют.

### Collision-решётка рельефа v1

HeightTile имеет version=1, epoch/revision uint32, целые northIndex/eastIndex в ±1024, resolution 2..257, spacingM в (0,100] и resolution² конечных downM в ±15000 м. Все горизонтальные узлы остаются в локальных 15 км. Ряд растёт на север, столбец на восток; начало фиксировано в NED. Ячейка имеет треугольники [a,a+1,a+n] и [a+1,a+n+1,a+n] с нормалью -Down. Высоты сохраняются Float64; вершины — Float32. Квантование вершин добавляет до примерно 1 мм в этом диапазоне и не устанавливает физическую точность рельефа.

Построение выполняется отдельным Worker. Stage владеет копией, проверяет epoch/решётку, возрастающие ревизии, точные высоты общих рёбер и фиксированную ёмкость 1..256 (по умолчанию 64). Сумма active+pending-буферов ограничена байтами (по умолчанию 64 MiB, настраивается до CPU-предела 512 MiB); до публикации замена должна вмещать старые и новые данные. Publish заменяет указатели только при строго возрастающем тике нужного epoch. Визуальные ресурсы не могут вытеснить collision-поверхность. downAt/sampleInto используют треугольную поверхность, не билинейную интерполяцию. Без земли возвращается NaN; readyAround/readyFrom требуют все плитки защитного квадрата с радиусом<=половины чанка. Высокочастотный интерфейс использует готовые typed-array входы/выходы; скалярные методы холодные. Библиотека не подключена к Rapier или допуску полёта; подготовка/удаление коллайдеров и production contact G1 остаются требованиями. Декодирования файлов внутри физики нет.

### Декларативный сценарий v1

Допуск копирует и замораживает id, hz 400/800/1200, uint32 seed, SHA-256 модели/прошивки, длительность 1..4320000 тиков, <=128 упорядоченных событий и рубрику удержания высоты. Допускаются только проверенные шаблоны weather.set/fault.set протокола v2, expectedEpoch=0, requestId подряд от 1 и atTick, точно равный тику события. Владелец обязан привязать действующий epoch, отправить через существующую очередь и проверить ACK до объявления отказа применённым. Runner возвращает неизменные индексы, не выделяет память в polling и использует симуляционные тики; пауза не расходует время. Обратный/пропущенный тик даёт -2 вместо позднего исполнения. Reset явно возвращает курсор. Несовпадение происхождения/seed/hz отклоняет запуск.

Рубрика требует каждый целый тик удержания ровно один раз, конечную высоту, реальный источник автопилота и здоровый EKF по настройке. Пробелы, превышение высоты и нездоровый EKF проваливают проверку; неполные/синтетические трассы блокируют. Pilot-basics содержит нулевые хеши только для структурных тестов, это не сертифицированный урок борта/прошивки. Production-владелец сценария/живая РЭБ-интеграция остаются заблокированы TASK-042/043/059/075.

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
