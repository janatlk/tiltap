import type { Annotator, Role } from "../db/repos/datasetRepo";

/**
 * Кто что может. Одна таблица на весь модуль.
 *
 * Разложить эти проверки по обработчикам — значит гарантировать, что новый
 * обработчик однажды забудут проверить, и он окажется открыт для всех.
 */

export interface Capabilities {
  /** Править расшифровки. */
  annotate: boolean;
  /** Добавлять записи. */
  createTask: boolean;
  /** Удалять записи вместе с аудио. */
  deleteTask: boolean;
  /** Собирать и скачивать выгрузку корпуса. */
  export: boolean;
  /** Заводить людей, менять им роли и пароли. */
  manageUsers: boolean;
}

const CAPABILITIES: Record<Role, Capabilities> = {
  super_admin: { annotate: true, createTask: true, deleteTask: true, export: true, manageUsers: true },
  annotator: { annotate: true, createTask: true, deleteTask: false, export: false, manageUsers: false },
  // Смотритель видит работу и слушает аудио, но ничего не меняет и не уносит
  // корпус наружу: наблюдение за ходом работы и доступ к её результату — разные
  // вещи, и вторая должна оставаться решением администратора.
  viewer: { annotate: false, createTask: false, deleteTask: false, export: false, manageUsers: false },
};

export const ROLE_NAMES: Record<Role, string> = {
  super_admin: "Супер-админ",
  annotator: "Разметчик",
  viewer: "Смотритель",
};

export const ROLES = Object.keys(CAPABILITIES) as Role[];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as string[]).includes(value);
}

/** Роль может быть NULL у строк, переживших миграцию, — считаем разметчиком. */
export function roleOf(annotator: Annotator): Role {
  return isRole(annotator.role) ? annotator.role : "annotator";
}

export function can(annotator: Annotator, capability: keyof Capabilities): boolean {
  return CAPABILITIES[roleOf(annotator)][capability];
}

export function capabilitiesOf(annotator: Annotator): Capabilities {
  return CAPABILITIES[roleOf(annotator)];
}

export function isSuperAdmin(annotator: Annotator): boolean {
  return roleOf(annotator) === "super_admin";
}
