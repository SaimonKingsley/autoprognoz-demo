export const MODES = ['history', 'estimate', 'forecast', 'scenario', 'insufficient_data'];
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
export function validateSnapshot(s) {
  if (!s || s.schema_version !== '0.1-draft' || s.is_fixture !== true || !Array.isArray(s.vehicles)) throw new Error('Ожидался учебный snapshot версии 0.1-draft');
  const ids = new Set();
  for (const v of s.vehicles) {
    if (!v.id || ids.has(v.id) || !MODES.includes(v.mode) || !(isoDate(v.data_as_of) || (v.mode === 'insufficient_data' && v.data_as_of === null))) throw new Error('Некорректная карточка автомобиля');
    ids.add(v.id);
    if (!v.make || !v.model || !v.generation || !Number.isInteger(v.year) || !Array.isArray(v.mileage_band) || v.mileage_band.length !== 2 || !v.mileage_band.every(Number.isFinite) || v.mileage_band[0] > v.mileage_band[1]) throw new Error('Неполные параметры группы');
    if (!Array.isArray(v.history) || !Array.isArray(v.projection)) throw new Error('Некорректные ряды');
    let previous = '';
    for (const p of v.history) {
      if (!isoDate(p.date) || p.date <= previous || p.date > v.data_as_of || !Number.isFinite(p.price) || p.price <= 0) throw new Error('Некорректная история');
      previous = p.date;
    }
    let horizon = 0;
    for (const p of v.projection) {
      const noInterval = v.mode === 'scenario' && p.lower === null && p.upper === null;
      if (!Number.isInteger(p.months) || p.months <= horizon || p.months > 12 || !Number.isFinite(p.price) || p.price <= 0 || (!noInterval && (![p.lower,p.upper].every(Number.isFinite) || p.lower <= 0 || p.lower > p.price || p.price > p.upper))) throw new Error('Некорректный интервал');
      horizon = p.months;
    }
    const noLevel = ['forecast','scenario'].includes(v.mode) && v.estimate === null && !v.history.length;
    if (v.mode !== 'insufficient_data' && ((!noLevel && (!Number.isFinite(v.estimate) || v.estimate <= 0)) || (v.mode==='history' && !v.history.length) || !Number.isInteger(v.n_unique) || v.n_unique < 0)) throw new Error('Нет основы для оценки');
    if (v.mode === 'forecast' && typeof v.quality_passed !== 'boolean') throw new Error('Нет статуса качества');
  }
  return s;
}
export function resolveResult(vehicle, selection, now = new Date()) {
  if (!vehicle || vehicle.mode === 'insufficient_data') return { mode: 'insufficient_data', reason: vehicle?.refusal_reason || 'Для этой модели пока нет учебного набора. Рыночные данные ещё не подключены.', projection: [] };
  if (selection.region !== vehicle.region || selection.year !== vehicle.year || !Number.isFinite(selection.mileage) || selection.mileage < vehicle.mileage_band[0] || selection.mileage > vehicle.mileage_band[1]) return { mode: 'insufficient_data', reason: 'Выбранные параметры выходят за пределы группы: измените регион или пробег. Мы не подставляем цену другого автомобиля.', projection: [] };
  const age = Math.floor((now.getTime() - Date.parse(`${vehicle.data_as_of}T00:00:00Z`)) / 86400000);
  if (age < 0) return { mode: 'insufficient_data', reason: 'Дата наблюдений находится в будущем. Результат скрыт до проверки набора.', projection: [] };
  if (age > 60 && !vehicle.history.length) return {mode:'insufficient_data',reason:'Данные устарели, а исторические наблюдения не предоставлены. Текущая оценка скрыта.',projection:[]};
  const warnings = [];
  let mode = vehicle.mode;
  if (age > 60) { mode = 'history'; warnings.push('Наблюдения старше 60 дней. Текущая оценка и будущая динамика скрыты; доступна только история на дату набора.'); }
  else if (age > 30) warnings.push('Наблюдения старше 30 дней: результат требует обновления.');
  if (mode === 'forecast' && vehicle.quality_passed !== true) { mode = 'history'; warnings.push('Прогноз не прошёл проверку качества. Показываем только историю.'); }
  if (mode === 'scenario') warnings.push('Это вымышленный учебный сценарий, а не проверенный прогноз рынка.');
  const projection = ['scenario','forecast'].includes(mode) ? vehicle.projection : [];
  return { mode, warnings, projection, stale: age > 60, estimate: age > 60 && vehicle.value_kind === 'estimate' ? vehicle.history.at(-1)?.price ?? null : vehicle.estimate, ageDays: age };
}
export function direction(current, p) {
  if (!p) return 'Будущая динамика не рассчитана';
  if (!Number.isFinite(current)) return 'Нет исходного уровня для сравнения';
  if (!Number.isFinite(p.lower) || !Number.isFinite(p.upper)) return 'Для сценария интервал не задан';
  if (p.lower <= current && p.upper >= current) return 'Направление не определено';
  return p.lower > current ? 'Весь интервал выше исходного уровня' : 'Весь интервал ниже исходного уровня';
}
export const rub = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value) + ' ₽';
export const dateLabel = date => new Date(`${date}T00:00:00Z`).toLocaleDateString('ru-RU', { day:'numeric', month:'long', year:'numeric', timeZone:'UTC' });
