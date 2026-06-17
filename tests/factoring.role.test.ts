import { describe, it, expect } from 'vitest';
import {
  createProgramExecAuthorityInfo,
  createEd25519AuthorityInfo,
  getMockAuthorityFromCreateAuthorityInfo,
} from '@swig-wallet/lib';
import { findProgramExecRoleId } from '../src/factoring/instantPayout.js';
import {
  SWIG_PROGRAM_EXEC_PREFIX,
  SWIG_PROGRAM_EXEC_PREFIX_SETTLE_TAB,
  SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED,
} from '../src/instructions/swigBundle.js';
import { DEXTER_VAULT_PROGRAM_ID } from '../src/constants/index.js';

const VAULT_PID = Uint8Array.from(DEXTER_VAULT_PROGRAM_ID.toBytes());
// A different program id — used to prove we also match on program, not just marker.
const OTHER_PID = new Uint8Array(32).fill(7);

function progExecRole(id: number, programId: Uint8Array, marker: Uint8Array) {
  return {
    id,
    authority: getMockAuthorityFromCreateAuthorityInfo(
      createProgramExecAuthorityInfo(programId, marker),
    ),
  };
}

function ed25519Role(id: number) {
  return {
    id,
    authority: getMockAuthorityFromCreateAuthorityInfo(
      createEd25519AuthorityInfo(new Uint8Array(32).fill(1)),
    ),
  };
}

describe('findProgramExecRoleId', () => {
  it('matches by MARKER on a fresh bundle layout (settle_locked at role 4)', () => {
    const swig = {
      roles: [
        ed25519Role(0), // bootstrap Ed25519 — must be skipped by the type guard
        progExecRole(1, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX), // finalize_withdrawal
        ed25519Role(2), // session Ed25519
        progExecRole(3, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX_SETTLE_TAB),
        progExecRole(4, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED),
      ],
    };
    const id = findProgramExecRoleId(
      swig,
      VAULT_PID,
      SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED,
    );
    expect(id).toBe(4);
  });

  it('matches by MARKER on a BACKFILLED layout (settle_locked at a different index, role 7)', () => {
    // registerProgramAuthority/T2 backfill appends the settle_locked marker at a
    // variable index. Index 4 here is a DIFFERENT marker — proving we match the
    // marker bytes, not the position.
    const swig = {
      roles: [
        ed25519Role(0),
        progExecRole(1, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX),
        ed25519Role(2),
        progExecRole(3, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX_SETTLE_TAB),
        progExecRole(4, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX), // duplicate finalize, NOT settle_locked
        ed25519Role(5),
        progExecRole(7, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED),
      ],
    };
    const id = findProgramExecRoleId(
      swig,
      VAULT_PID,
      SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED,
    );
    expect(id).toBe(7);
  });

  it('does NOT return role 1 (finalize) when settle_locked is requested', () => {
    const swig = {
      roles: [
        progExecRole(1, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX),
        progExecRole(4, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED),
      ],
    };
    const id = findProgramExecRoleId(
      swig,
      VAULT_PID,
      SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED,
    );
    expect(id).not.toBe(1);
    expect(id).toBe(4);
  });

  it('requires the program id to ALSO match (right marker, wrong program is rejected)', () => {
    const swig = {
      roles: [
        progExecRole(1, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX),
        // settle_locked marker but on a foreign program — must not match
        progExecRole(4, OTHER_PID, SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED),
      ],
    };
    expect(() =>
      findProgramExecRoleId(swig, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED),
    ).toThrow(/settle_locked/);
  });

  it('throws a clear error when no settle_locked ProgramExec role exists', () => {
    const swig = {
      roles: [
        ed25519Role(0),
        progExecRole(1, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX),
        progExecRole(3, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX_SETTLE_TAB),
      ],
    };
    expect(() =>
      findProgramExecRoleId(swig, VAULT_PID, SWIG_PROGRAM_EXEC_PREFIX_SETTLE_LOCKED),
    ).toThrow(/no settle_locked_voucher ProgramExec role/);
  });
});
