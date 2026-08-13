import { describe, it } from "node:test";
import assert from "node:assert";
import { isSuperAdmin, roleOf, can, ROLES } from "../services/datasetPermissions";
import type { Annotator } from "../db/repos/datasetRepo";

/**
 * Роли из системы разметки теперь охраняют и админку, поэтому цена ошибки в
 * них выросла: раньше лишнее право открывало чужую расшифровку, теперь оно
 * открывает журнал запросов и рассылку.
 *
 * Проверяем именно то, на что опирается requireAdmin: супер-админ проходит,
 * остальные нет, и ни одна роль не получает прав молча, только потому что её
 * добавили в список.
 */

function annotator(role: string): Annotator {
  return {
    id: 1,
    username: "someone",
    display_name: "Someone",
    password_hash: "x",
    role,
    active: true,
    created_at: new Date(),
    last_login_at: null,
  } as unknown as Annotator;
}

describe("dataset roles guarding the admin panel", () => {
  it("lets a super admin through", () => {
    assert.equal(isSuperAdmin(annotator("super_admin")), true);
  });

  it("keeps annotators and viewers out", () => {
    assert.equal(isSuperAdmin(annotator("annotator")), false);
    assert.equal(isSuperAdmin(annotator("viewer")), false);
  });

  it("treats an unknown or missing role as the least privileged one", () => {
    // Пустая или испорченная роль не должна открывать двери. Строка из базы
    // может оказаться любой, а падать здесь нельзя.
    assert.equal(isSuperAdmin(annotator("")), false);
    assert.equal(isSuperAdmin(annotator("root")), false);
    assert.equal(roleOf(annotator("root")), "annotator");
  });

  it("gives user management to the super admin alone", () => {
    const allowed = ROLES.filter((role) => can(annotator(role), "manageUsers"));
    assert.deepEqual(allowed, ["super_admin"]);
  });

  it("never lets a viewer change anything", () => {
    const viewer = annotator("viewer");
    for (const capability of ["annotate", "createTask", "deleteTask", "export", "manageUsers"] as const) {
      assert.equal(can(viewer, capability), false, capability + " must stay closed to a viewer");
    }
  });
});
