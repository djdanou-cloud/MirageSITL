# SPECS_SIMULATION_ENGINES.md

<!-- source-sha256: 979e66e5f0c5176b132513b9e676d43151d7b5c1f4360a99a96d86d21c673fd1 -->

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
