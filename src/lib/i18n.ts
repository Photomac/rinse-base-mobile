import AsyncStorage from '@react-native-async-storage/async-storage'

export type Language = 'en' | 'es'

export const translations = {
  en: {
    // Common
    back: 'Back', save: 'Save', cancel: 'Cancel', loading: 'Loading...', error: 'Error',
    done: 'Done', yes: 'Yes', no: 'No', optional: 'optional',
    // Auth
    sign_in: 'Sign in', email: 'Email', password: 'Password',
    email_placeholder: 'you@email.com', password_placeholder: 'Your password',
    login_failed: 'Login failed', contact_manager: 'Contact your manager if you need help logging in',
    tagline: 'Professional cleaning management',
    // Dashboard
    good_morning: 'Good morning', good_afternoon: 'Good afternoon', good_evening: 'Good evening',
    today: 'Today', done_label: 'Done', remaining: 'Remaining', this_month: 'This month',
    active_job: 'Active job in progress', next_job: 'Next job',
    todays_jobs: "Today's jobs", see_all: 'See all', no_jobs_today: 'No jobs scheduled today',
    my_earnings: 'My earnings this month', schedule: 'Schedule', log_miles: 'Log miles', profile: 'Profile',
    // Today
    no_jobs: 'No jobs today', enjoy_day: 'Enjoy your day off!',
    directions: 'Directions', call: 'Call', en_route: 'En route', start_job: 'Start job',
    complete: 'Complete', completed: 'Completed', supplies_needed: 'Supplies needed',
    lockbox: 'Lockbox', complete_confirm: 'Mark this job as completed?', turnover: 'Turnover',
    // Schedule
    my_schedule: 'My schedule', upcoming_jobs: 'upcoming jobs',
    no_jobs_day: 'No jobs this day', nothing_scheduled: 'Nothing scheduled',
    // Job detail
    job_detail: 'Job detail', arrival_instructions: 'Arrival instructions', lockbox_code: 'Lockbox code',
    clock_in: 'Clock in — Start job', clock_in_short: 'Clock in', pause: 'Pause', resume: 'Resume',
    complete_job: 'Complete', job_completed: 'Job completed', total_time: 'Total time',
    time_tracker: 'Time tracker', active_since: 'Active since', paused: 'Paused', session: 'Session',
    cleaning_checklist: 'Cleaning checklist', notes_optional: 'Notes (optional)',
    notes_placeholder: 'Any issues or observations...', job_photos: 'Job Photos',
    complete_job_confirm: 'Complete job?', checklist_incomplete: 'Checklist incomplete',
    checklist_incomplete_msg: 'Complete all items before marking done.',
    mark_done_anyway: 'Mark done anyway', call_client: 'Call',
    // Pause reasons
    pause_title: 'Why are you leaving?', pause_subtitle: 'This helps calculate your hours accurately',
    pause_job: 'Pause job', waiting_laundry: 'Waiting for laundry', going_another_job: 'Going to another job',
    supply_run: 'Supply run', waiting_access: 'Waiting for access', break_time: 'Break', other: 'Other',
    // SOS
    emergency_sos: 'Emergency SOS', hold_3_seconds: 'Press and hold for 3 seconds',
    sos_instruction: 'This will alert your owner and manager immediately.',
    sos_instruction2: 'If no response in 2 minutes, 911 will be called.',
    sos_warning: 'Only use in a genuine emergency',
    alert_sent: 'ALERT SENT', sos_sent_msg: 'Your owner and manager have been notified.',
    sos_sent_msg2: 'Help is on the way.', your_gps: 'Your GPS coordinates',
    call_911_in: '911 AUTO-CALL IN', im_ok: "I'm OK — Cancel SOS",
    calling_911: 'Calling 911...', read_gps: 'Read your GPS coordinates to dispatcher',
    cancel_sos: "Tap I'm OK if this was a mistake",
    // Photos
    take_photo: 'Take Photo', from_gallery: 'From Gallery', add_caption: 'Add a caption (optional)',
    visible_to_client: 'Visible to client', uploading: 'Uploading photo...',
    photo_saved: 'Photo saved successfully!', upload_failed: 'Upload failed',
    no_photos: 'No photos yet', no_photos_sub: 'Take before & after photos for this job',
    delete_photo: 'Delete photo?', delete_confirm: 'This cannot be undone.',
    long_press_delete: 'Long press a photo to delete it',
    required_photos: 'Required photos for this property',
    before: 'Before', after: 'After', damage: 'Damage', other_photo: 'Other',
    // Mileage
    my_mileage: 'My mileage', log_trip: 'Log trip', total_miles: 'Total miles',
    pending: 'Pending', approved: 'Approved', rate_label: 'Rate',
    log_trip_title: 'Log a trip', date: 'Date', from_label: 'From', to_label: 'To',
    miles: 'Miles', miles_placeholder: 'e.g. 12.5', purpose: 'Purpose',
    estimated: 'Estimated', submit_approval: 'Submit for approval',
    no_trips: 'No trips yet', no_trips_sub: 'Log your mileage to get reimbursed',
    job_travel: 'Job travel', supply_run_miles: 'Supply run', equipment_pickup: 'Equipment pickup',
    client_meeting: 'Client meeting', training: 'Training', flagged: 'Flagged',
    enter_valid_miles: 'Enter valid miles', enter_origin_dest: 'Enter origin and destination',
    // Profile
    profile_title: 'Profile', contact_info: 'Contact info', pay_structure: 'Pay structure',
    pay_type: 'Pay type', hourly: 'Hourly', per_job: 'Per job',
    hourly_rate: 'Hourly rate', per_job_rate: 'Per job rate',
    sign_out: 'Sign out', sign_out_confirm: 'Are you sure?', phone: 'Phone', not_set: 'Not set',
  },
  es: {
    // Common
    back: 'Atrás', save: 'Guardar', cancel: 'Cancelar', loading: 'Cargando...', error: 'Error',
    done: 'Listo', yes: 'Sí', no: 'No', optional: 'opcional',
    // Auth
    sign_in: 'Iniciar sesión', email: 'Correo', password: 'Contraseña',
    email_placeholder: 'tu@correo.com', password_placeholder: 'Tu contraseña',
    login_failed: 'Error al iniciar sesión', contact_manager: 'Contacta a tu gerente si necesitas ayuda',
    tagline: 'Gestión profesional de limpieza',
    // Dashboard
    good_morning: 'Buenos días', good_afternoon: 'Buenas tardes', good_evening: 'Buenas noches',
    today: 'Hoy', done_label: 'Hechos', remaining: 'Pendientes', this_month: 'Este mes',
    active_job: 'Trabajo en progreso', next_job: 'Próximo trabajo',
    todays_jobs: 'Trabajos de hoy', see_all: 'Ver todos', no_jobs_today: 'Sin trabajos hoy',
    my_earnings: 'Mis ganancias este mes', schedule: 'Horario', log_miles: 'Registrar millas', profile: 'Perfil',
    // Today
    no_jobs: 'Sin trabajos hoy', enjoy_day: 'Disfruta tu día libre',
    directions: 'Cómo llegar', call: 'Llamar', en_route: 'En camino', start_job: 'Iniciar trabajo',
    complete: 'Completar', completed: 'Completado', supplies_needed: 'Materiales necesarios',
    lockbox: 'Caja de llaves', complete_confirm: 'Marcar trabajo como completado?', turnover: 'Cambio de turno',
    // Schedule
    my_schedule: 'Mi horario', upcoming_jobs: 'trabajos próximos',
    no_jobs_day: 'Sin trabajos este día', nothing_scheduled: 'Nada programado',
    // Job detail
    job_detail: 'Detalle del trabajo', arrival_instructions: 'Instrucciones de llegada', lockbox_code: 'Código de caja',
    clock_in: 'Registrar entrada — Iniciar', clock_in_short: 'Registrar entrada', pause: 'Pausar', resume: 'Continuar',
    complete_job: 'Completar', job_completed: 'Trabajo completado', total_time: 'Tiempo total',
    time_tracker: 'Control de tiempo', active_since: 'Activo desde', paused: 'Pausado', session: 'Sesión',
    cleaning_checklist: 'Lista de limpieza', notes_optional: 'Notas (opcional)',
    notes_placeholder: 'Problemas u observaciones...', job_photos: 'Fotos del trabajo',
    complete_job_confirm: 'Completar trabajo?', checklist_incomplete: 'Lista incompleta',
    checklist_incomplete_msg: 'Completa todos los elementos antes de terminar.',
    mark_done_anyway: 'Marcar como terminado igual', call_client: 'Llamar',
    // Pause reasons
    pause_title: 'Por que te vas?', pause_subtitle: 'Esto ayuda a calcular tus horas correctamente',
    pause_job: 'Pausar trabajo', waiting_laundry: 'Esperando lavandería', going_another_job: 'Ir a otro trabajo',
    supply_run: 'Buscar materiales', waiting_access: 'Esperando acceso', break_time: 'Descanso', other: 'Otro',
    // SOS
    emergency_sos: 'SOS de Emergencia', hold_3_seconds: 'Presiona y mantén 3 segundos',
    sos_instruction: 'Esto alertará a tu dueño y gerente inmediatamente.',
    sos_instruction2: 'Sin respuesta en 2 minutos, se llamará al 911.',
    sos_warning: 'Solo usar en una emergencia real',
    alert_sent: 'ALERTA ENVIADA', sos_sent_msg: 'Tu dueño y gerente han sido notificados.',
    sos_sent_msg2: 'La ayuda está en camino.', your_gps: 'Tus coordenadas GPS',
    call_911_in: 'LLAMADA AL 911 EN', im_ok: 'Estoy bien — Cancelar SOS',
    calling_911: 'Llamando al 911...', read_gps: 'Lee tus coordenadas GPS al despachador',
    cancel_sos: 'Toca Estoy bien si fue un error',
    // Photos
    take_photo: 'Tomar foto', from_gallery: 'De galería', add_caption: 'Agregar descripción (opcional)',
    visible_to_client: 'Visible para el cliente', uploading: 'Subiendo foto...',
    photo_saved: 'Foto guardada exitosamente', upload_failed: 'Error al subir',
    no_photos: 'Sin fotos aún', no_photos_sub: 'Toma fotos antes y después del trabajo',
    delete_photo: 'Eliminar foto?', delete_confirm: 'Esto no se puede deshacer.',
    long_press_delete: 'Mantén presionada una foto para eliminarla',
    required_photos: 'Fotos requeridas para esta propiedad',
    before: 'Antes', after: 'Después', damage: 'Daño', other_photo: 'Otro',
    // Mileage
    my_mileage: 'Mis millas', log_trip: 'Registrar viaje', total_miles: 'Millas totales',
    pending: 'Pendiente', approved: 'Aprobado', rate_label: 'Tarifa',
    log_trip_title: 'Registrar un viaje', date: 'Fecha', from_label: 'Desde', to_label: 'Hasta',
    miles: 'Millas', miles_placeholder: 'ej. 12.5', purpose: 'Propósito',
    estimated: 'Estimado', submit_approval: 'Enviar para aprobación',
    no_trips: 'Sin viajes aún', no_trips_sub: 'Registra tus millas para ser reembolsado',
    job_travel: 'Viaje al trabajo', supply_run_miles: 'Buscar materiales', equipment_pickup: 'Recoger equipo',
    client_meeting: 'Reunión con cliente', training: 'Entrenamiento', flagged: 'Marcado',
    enter_valid_miles: 'Ingresa millas válidas', enter_origin_dest: 'Ingresa origen y destino',
    // Profile
    profile_title: 'Perfil', contact_info: 'Información de contacto', pay_structure: 'Estructura de pago',
    pay_type: 'Tipo de pago', hourly: 'Por hora', per_job: 'Por trabajo',
    hourly_rate: 'Tarifa por hora', per_job_rate: 'Tarifa por trabajo',
    sign_out: 'Cerrar sesión', sign_out_confirm: 'Estás seguro?', phone: 'Teléfono', not_set: 'No configurado',
  }
}

export type TranslationKey = keyof typeof translations.en

export function t(lang: Language, key: TranslationKey): string {
  return translations[lang][key] || translations.en[key] || key
}

export async function getLanguage(): Promise<Language> {
  try {
    const lang = await AsyncStorage.getItem('language')
    return (lang as Language) || 'en'
  } catch {
    return 'en'
  }
}

export async function setLanguage(lang: Language): Promise<void> {
  await AsyncStorage.setItem('language', lang)
}
