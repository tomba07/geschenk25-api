/**
 * Secret Santa Matcher using bipartite matching algorithm
 * Supports exclusions by only adding valid connections
 */
export class SecretSantaMatcher {
  private givers: number[];
  private receivers: number[];
  private participantConnections: number[][];
  private secretSantaPair: number[];
  private searchDistance: number[]; // Extended to include sentinel

  constructor(givers: number[], receivers: number[]) {
    const participantsCount = givers.length + receivers.length;

    this.givers = givers;
    this.receivers = receivers;
    this.participantConnections = new Array(participantsCount).fill(null).map(() => []);
    this.secretSantaPair = new Array(participantsCount).fill(-1);
    // searchDistance needs one extra slot for sentinel (at index participantsCount)
    this.searchDistance = new Array(participantsCount + 1).fill(Number.POSITIVE_INFINITY);
  }

  /**
   * Shuffle connections for randomness
   */
  private shuffleParticipantConnections(): void {
    this.participantConnections.forEach((edges) => {
      // Fisher-Yates shuffle
      for (let i = edges.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [edges[i], edges[j]] = [edges[j], edges[i]];
      }
    });
  }

  /**
   * Add a valid pairing (giver can be assigned to receiver)
   * @param giver Index of giver (0 to givers.length - 1)
   * @param receiver Index of receiver (0 to receivers.length - 1)
   */
  addSecretSantaPairing(giver: number, receiver: number): void {
    if (
      giver < 0 ||
      giver >= this.givers.length ||
      receiver < 0 ||
      receiver >= this.receivers.length
    ) {
      throw new Error('Participant indices are out of bounds.');
    }
    // In bipartite graph: giver index is giver, receiver index is giver.length + receiver
    const receiverIndex = this.givers.length + receiver;
    this.participantConnections[giver].push(receiverIndex);
  }

  /**
   * Initialize BFS layer for Hopcroft-Karp algorithm
   */
  private initializeSearchLayer(): boolean {
    const participantsCount = this.participantConnections.length;
    this.searchDistance.fill(Infinity);
    const queue: number[] = [];

    // Start BFS from unmatched givers
    for (let participant = 0; participant < this.givers.length; participant++) {
      if (this.secretSantaPair[participant] === -1) {
        this.searchDistance[participant] = 0;
        queue.push(participant);
      }
    }

    // Use participantsCount as sentinel for unmatched receivers
    this.searchDistance[participantsCount] = Infinity;

    while (queue.length > 0) {
      const currentParticipant = queue.shift()!;
      if (currentParticipant !== -1 && currentParticipant < participantsCount) {
        this.participantConnections[currentParticipant].forEach((possiblePair) => {
          const pairedParticipant = this.secretSantaPair[possiblePair];
          const pairedIndex = pairedParticipant === -1 ? participantsCount : pairedParticipant;
          if (this.searchDistance[pairedIndex] === Infinity) {
            this.searchDistance[pairedIndex] = this.searchDistance[currentParticipant] + 1;
            if (pairedIndex !== participantsCount) {
              queue.push(pairedIndex);
            }
          }
        });
      }
    }

    return this.searchDistance[participantsCount] !== Infinity;
  }

  /**
   * Attempt to assign a participant using DFS
   */
  private attemptAssignment(participant: number): boolean {
    const participantsCount = this.participantConnections.length;
    if (participant === -1 || participant === participantsCount) {
      return true;
    }

    return this.participantConnections[participant].some((potentialPair) => {
      const pairedParticipant = this.secretSantaPair[potentialPair];
      const pairedIndex = pairedParticipant === -1 ? participantsCount : pairedParticipant;
      if (this.searchDistance[pairedIndex] === this.searchDistance[participant] + 1) {
        if (this.attemptAssignment(pairedIndex)) {
          this.secretSantaPair[potentialPair] = participant;
          this.secretSantaPair[participant] = potentialPair;
          return true;
        }
      }
      return false;
    });
  }

  /**
   * Generate Secret Santa pairs using bipartite matching
   * @returns Map of giver ID to receiver ID
   */
  generateSecretSantaPairs(): Map<number, number> {
    const numberOfGivers = this.givers.length;

    // Shuffle for randomness
    this.shuffleParticipantConnections();

    // Run Hopcroft-Karp algorithm
    while (this.initializeSearchLayer()) {
      for (let participant = 0; participant < numberOfGivers; participant++) {
        if (this.secretSantaPair[participant] === -1) {
          this.attemptAssignment(participant);
        }
      }
    }

    // Build result map: giver ID -> receiver ID
    const pairs = new Map<number, number>();

    for (let i = 0; i < numberOfGivers; i++) {
      if (this.secretSantaPair[i] !== -1) {
        const receiverIndex = this.secretSantaPair[i] - numberOfGivers;
        const giverId = this.givers[i];
        const receiverId = this.receivers[receiverIndex];
        pairs.set(giverId, receiverId);
      }
    }

    return pairs;
  }
}

