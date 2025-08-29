// capture-registry.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface CaptureEvent {
  facilityPrincipal: string;
  co2Amount: number;
  timestamp: number;
  docHash: Buffer;
  metadata: string;
  status: string;
  lastUpdated: number;
}

interface EventVersion {
  updatedCo2Amount: number;
  updatedDocHash: Buffer;
  updateNotes: string;
  timestamp: number;
}

interface Collaborator {
  role: string;
  permissions: string[];
  addedAt: number;
}

interface Note {
  author: string;
  content: string;
  timestamp: number;
}

interface ContractState {
  captureEvents: Map<number, CaptureEvent>;
  eventHashes: Map<Buffer, { eventId: number }>;
  eventVersions: Map<string, EventVersion>; // Key as `${eventId}-${version}`
  eventCollaborators: Map<string, Collaborator>; // Key as `${eventId}-${collaborator}`
  eventNotes: Map<string, Note>; // Key as `${eventId}-${noteId}`
  nextEventId: number;
  contractPaused: boolean;
  contractAdmin: string;
  noteCounter: number;
}

// Mock contract implementation
class CaptureRegistryMock {
  private state: ContractState = {
    captureEvents: new Map(),
    eventHashes: new Map(),
    eventVersions: new Map(),
    eventCollaborators: new Map(),
    eventNotes: new Map(),
    nextEventId: 1,
    contractPaused: false,
    contractAdmin: "deployer",
    noteCounter: 1,
  };

  private MAX_METADATA_LEN = 1000;
  private STATUS_PENDING = "pending";
  private STATUS_VERIFIED = "verified";
  private STATUS_REJECTED = "rejected";
  private STATUS_UPDATED = "updated";
  private ERR_UNAUTHORIZED = 100;
  private ERR_ALREADY_REGISTERED = 101;
  private ERR_INVALID_AMOUNT = 102;
  private ERR_INVALID_HASH = 103;
  private ERR_INVALID_STATUS = 104;
  private ERR_INVALID_METADATA_LEN = 105;
  private ERR_NOT_FOUND = 106;
  private ERR_PAUSED = 107;

  private mockBlockHeight = 1000;

  private getBlockHeight(): number {
    return this.mockBlockHeight++;
  }

  private isAdmin(caller: string): boolean {
    return caller === this.state.contractAdmin;
  }

  private hasPermission(eventId: number, caller: string, permission: string): boolean {
    const key = `${eventId}-${caller}`;
    const collab = this.state.eventCollaborators.get(key);
    return collab ? collab.permissions.includes(permission) : false;
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (!this.isAdmin(caller)) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.contractPaused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (!this.isAdmin(caller)) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.contractPaused = false;
    return { ok: true, value: true };
  }

  setAdmin(caller: string, newAdmin: string): ClarityResponse<boolean> {
    if (!this.isAdmin(caller)) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.contractAdmin = newAdmin;
    return { ok: true, value: true };
  }

  registerCaptureEvent(
    caller: string,
    co2Amount: number,
    docHash: Buffer,
    metadata: string
  ): ClarityResponse<number> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (co2Amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    if (this.state.eventHashes.has(docHash)) {
      return { ok: false, value: this.ERR_ALREADY_REGISTERED };
    }
    if (metadata.length > this.MAX_METADATA_LEN) {
      return { ok: false, value: this.ERR_INVALID_METADATA_LEN };
    }
    const eventId = this.state.nextEventId;
    const timestamp = this.getBlockHeight();
    this.state.captureEvents.set(eventId, {
      facilityPrincipal: caller,
      co2Amount,
      timestamp,
      docHash,
      metadata,
      status: this.STATUS_PENDING,
      lastUpdated: timestamp,
    });
    this.state.eventHashes.set(docHash, { eventId });
    this.state.nextEventId++;
    return { ok: true, value: eventId };
  }

  updateEventStatus(
    caller: string,
    eventId: number,
    newStatus: string
  ): ClarityResponse<boolean> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const event = this.state.captureEvents.get(eventId);
    if (!event) {
      return { ok: false, value: this.ERR_NOT_FOUND };
    }
    const authorized =
      event.facilityPrincipal === caller ||
      this.hasPermission(eventId, caller, "update-status") ||
      this.isAdmin(caller);
    if (!authorized) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (
      ![
        this.STATUS_VERIFIED,
        this.STATUS_REJECTED,
        this.STATUS_UPDATED,
      ].includes(newStatus)
    ) {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    const lastUpdated = this.getBlockHeight();
    this.state.captureEvents.set(eventId, {
      ...event,
      status: newStatus,
      lastUpdated,
    });
    return { ok: true, value: true };
  }

  addEventVersion(
    caller: string,
    eventId: number,
    version: number,
    updatedCo2Amount: number,
    updatedDocHash: Buffer,
    updateNotes: string
  ): ClarityResponse<boolean> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const event = this.state.captureEvents.get(eventId);
    if (!event) {
      return { ok: false, value: this.ERR_NOT_FOUND };
    }
    const authorized =
      event.facilityPrincipal === caller ||
      this.hasPermission(eventId, caller, "add-version");
    if (!authorized) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (updatedCo2Amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    const key = `${eventId}-${version}`;
    const timestamp = this.getBlockHeight();
    this.state.eventVersions.set(key, {
      updatedCo2Amount,
      updatedDocHash,
      updateNotes,
      timestamp,
    });
    this.state.captureEvents.set(eventId, {
      ...event,
      status: this.STATUS_UPDATED,
      lastUpdated: timestamp,
    });
    return { ok: true, value: true };
  }

  addCollaborator(
    caller: string,
    eventId: number,
    collaborator: string,
    role: string,
    permissions: string[]
  ): ClarityResponse<boolean> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const event = this.state.captureEvents.get(eventId);
    if (!event) {
      return { ok: false, value: this.ERR_NOT_FOUND };
    }
    if (event.facilityPrincipal !== caller) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    const key = `${eventId}-${collaborator}`;
    const addedAt = this.getBlockHeight();
    this.state.eventCollaborators.set(key, {
      role,
      permissions,
      addedAt,
    });
    return { ok: true, value: true };
  }

  addNote(
    caller: string,
    eventId: number,
    content: string
  ): ClarityResponse<number> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const event = this.state.captureEvents.get(eventId);
    if (!event) {
      return { ok: false, value: this.ERR_NOT_FOUND };
    }
    const authorized =
      event.facilityPrincipal === caller ||
      this.hasPermission(eventId, caller, "add-notes") ||
      this.isAdmin(caller);
    if (!authorized) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (content.length > this.MAX_METADATA_LEN) {
      return { ok: false, value: this.ERR_INVALID_METADATA_LEN };
    }
    const noteId = this.state.noteCounter;
    const key = `${eventId}-${noteId}`;
    const timestamp = this.getBlockHeight();
    this.state.eventNotes.set(key, {
      author: caller,
      content,
      timestamp,
    });
    this.state.noteCounter++;
    return { ok: true, value: noteId };
  }

  getEventDetails(eventId: number): ClarityResponse<CaptureEvent | null> {
    return { ok: true, value: this.state.captureEvents.get(eventId) ?? null };
  }

  getEventVersion(eventId: number, version: number): ClarityResponse<EventVersion | null> {
    const key = `${eventId}-${version}`;
    return { ok: true, value: this.state.eventVersions.get(key) ?? null };
  }

  getCollaborator(eventId: number, collaborator: string): ClarityResponse<Collaborator | null> {
    const key = `${eventId}-${collaborator}`;
    return { ok: true, value: this.state.eventCollaborators.get(key) ?? null };
  }

  getNote(eventId: number, noteId: number): ClarityResponse<Note | null> {
    const key = `${eventId}-${noteId}`;
    return { ok: true, value: this.state.eventNotes.get(key) ?? null };
  }

  getNextEventId(): ClarityResponse<number> {
    return { ok: true, value: this.state.nextEventId };
  }

  isContractPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.contractPaused };
  }

  getContractAdmin(): ClarityResponse<string> {
    return { ok: true, value: this.state.contractAdmin };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  facility: "facility_1",
  auditor: "auditor_1",
  user: "user_1",
};

describe("CaptureRegistry Contract", () => {
  let contract: CaptureRegistryMock;

  beforeEach(() => {
    contract = new CaptureRegistryMock();
    vi.resetAllMocks();
  });

  it("should allow admin to pause and unpause contract", () => {
    const pauseResult = contract.pauseContract(accounts.deployer);
    expect(pauseResult).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: true });

    const registerDuringPause = contract.registerCaptureEvent(
      accounts.facility,
      1000000,
      Buffer.from("hash1"),
      "Test metadata"
    );
    expect(registerDuringPause).toEqual({ ok: false, value: 107 });

    const unpauseResult = contract.unpauseContract(accounts.deployer);
    expect(unpauseResult).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: false });
  });

  it("should prevent non-admin from pausing", () => {
    const pauseResult = contract.pauseContract(accounts.user);
    expect(pauseResult).toEqual({ ok: false, value: 100 });
  });

  it("should register a new capture event", () => {
    const docHash = Buffer.from("uniquehash1234567890123456789012"); // 32 bytes
    const registerResult = contract.registerCaptureEvent(
      accounts.facility,
      1000000, // 1 ton
      docHash,
      "Capture at facility X using method Y"
    );
    expect(registerResult).toEqual({ ok: true, value: 1 });

    const eventDetails = contract.getEventDetails(1);
    expect(eventDetails).toEqual({
      ok: true,
      value: expect.objectContaining({
        facilityPrincipal: accounts.facility,
        co2Amount: 1000000,
        metadata: "Capture at facility X using method Y",
        status: "pending",
      }),
    });
  });

  it("should prevent duplicate registration by hash", () => {
    const docHash = Buffer.from("duplicatehash1234567890123456789");
    contract.registerCaptureEvent(
      accounts.facility,
      1000000,
      docHash,
      "First"
    );

    const duplicateResult = contract.registerCaptureEvent(
      accounts.facility,
      2000000,
      docHash,
      "Duplicate"
    );
    expect(duplicateResult).toEqual({ ok: false, value: 101 });
  });

  it("should prevent registration with invalid amount", () => {
    const result = contract.registerCaptureEvent(
      accounts.facility,
      0,
      Buffer.from("hash"),
      "Invalid"
    );
    expect(result).toEqual({ ok: false, value: 102 });
  });

  it("should prevent metadata exceeding max length", () => {
    const longMetadata = "a".repeat(1001);
    const result = contract.registerCaptureEvent(
      accounts.facility,
      1000000,
      Buffer.from("longhash123456789012345678901234"),
      longMetadata
    );
    expect(result).toEqual({ ok: false, value: 105 });
  });

  it("should update event status by authorized user", () => {
    const docHash = Buffer.from("statushash1234567890123456789012");
    contract.registerCaptureEvent(
      accounts.facility,
      1000000,
      docHash,
      "Test"
    );

    const updateResult = contract.updateEventStatus(
      accounts.facility,
      1,
      "verified"
    );
    expect(updateResult).toEqual({ ok: true, value: true });

    const eventDetails = contract.getEventDetails(1);
    expect(eventDetails.value?.status).toBe("verified");
  });

  it("should prevent unauthorized status update", () => {
    const docHash = Buffer.from("unauthhash1234567890123456789012");
    contract.registerCaptureEvent(
      accounts.facility,
      1000000,
      docHash,
      "Test"
    );

    const updateResult = contract.updateEventStatus(
      accounts.user,
      1,
      "verified"
    );
    expect(updateResult).toEqual({ ok: false, value: 100 });
  });

  it("should add collaborator and allow permission-based actions", () => {
    const docHash = Buffer.from("collabhash1234567890123456789012");
    contract.registerCaptureEvent(
      accounts.facility,
      1000000,
      docHash,
      "Test"
    );

    const addCollabResult = contract.addCollaborator(
      accounts.facility,
      1,
      accounts.auditor,
      "auditor",
      ["update-status", "add-notes"]
    );
    expect(addCollabResult).toEqual({ ok: true, value: true });

    const updateByCollab = contract.updateEventStatus(
      accounts.auditor,
      1,
      "verified"
    );
    expect(updateByCollab).toEqual({ ok: true, value: true });
  });

  it("should add event version", () => {
    const docHash = Buffer.from("versionhash123456789012345678901");
    contract.registerCaptureEvent(
      accounts.facility,
      1000000,
      docHash,
      "Initial"
    );

    const newDocHash = Buffer.from("newhash123456789012345678901234");
    const addVersionResult = contract.addEventVersion(
      accounts.facility,
      1,
      1,
      1500000,
      newDocHash,
      "Adjusted measurements"
    );
    expect(addVersionResult).toEqual({ ok: true, value: true });

    const versionDetails = contract.getEventVersion(1, 1);
    expect(versionDetails).toEqual({
      ok: true,
      value: expect.objectContaining({
        updatedCo2Amount: 1500000,
        updateNotes: "Adjusted measurements",
      }),
    });

    const eventDetails = contract.getEventDetails(1);
    expect(eventDetails.value?.status).toBe("updated");
  });

  it("should add note by authorized user", () => {
    const docHash = Buffer.from("notehash12345678901234567890123");
    contract.registerCaptureEvent(
      accounts.facility,
      1000000,
      docHash,
      "Test"
    );

    const addNoteResult = contract.addNote(
      accounts.facility,
      1,
      "Verification complete, data accurate"
    );
    expect(addNoteResult).toEqual({ ok: true, value: 1 });

    const noteDetails = contract.getNote(1, 1);
    expect(noteDetails).toEqual({
      ok: true,
      value: expect.objectContaining({
        author: accounts.facility,
        content: "Verification complete, data accurate",
      }),
    });
  });

  it("should prevent unauthorized note addition", () => {
    const docHash = Buffer.from("unauthnote123456789012345678901");
    contract.registerCaptureEvent(
      accounts.facility,
      1000000,
      docHash,
      "Test"
    );

    const addNoteResult = contract.addNote(
      accounts.user,
      1,
      "Unauthorized note"
    );
    expect(addNoteResult).toEqual({ ok: false, value: 100 });
  });
});