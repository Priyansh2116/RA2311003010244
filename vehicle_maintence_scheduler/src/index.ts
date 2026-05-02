import axios from 'axios';
import * as dotenv from 'dotenv';
import { Log, setAuthToken } from '../../logging_middleware/src/index';

dotenv.config();

const EVALUATION_SERVER = 'http://20.207.122.201/evaluation-service';
const SERVICE_TAG = 'vehicle_maintence_scheduler';

interface DepotRecord {
  ID: number;
  MechanicHours: number;
}

interface MaintenanceTask {
  TaskID: string;
  Duration: number;
  Impact: number;
}

interface DepotSchedule {
  depotID: number;
  budgetHours: number;
  assignedTasks: MaintenanceTask[];
  totalImpactScore: number;
  consumedHours: number;
}

function buildAuthHeader(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}


// Knapsack DP 


/**
 * to construct the bottom-up DP value table
 * iterate the capacity backwards 
 * task is only be selected once per depo
 */
function buildValueTable(tasks: MaintenanceTask[], capacity: number): number[] {
  const valueTable = new Array<number>(capacity + 1).fill(0);

  let taskIdx = 0;
  while (taskIdx < tasks.length) {
    const { Duration: duration, Impact: impact } = tasks[taskIdx];
    let remaining = capacity;

    while (remaining >= duration) {
      const withoutCurrent = valueTable[remaining - duration] + impact;
      if (withoutCurrent > valueTable[remaining]) {
        valueTable[remaining] = withoutCurrent;
      }
      remaining--;
    }

    taskIdx++;
  }

  return valueTable;
}

function buildSelectionTrace(tasks: MaintenanceTask[], capacity: number): boolean[][] {
  const selectionTrace: boolean[][] = Array.from(
    { length: tasks.length },
    () => new Array<boolean>(capacity + 1).fill(false),
  );

  // recompute dp inlinee
  const dpTable = new Array<number>(capacity + 1).fill(0);

  let i = 0;
  while (i < tasks.length) {
    const { Duration: d, Impact: v } = tasks[i];
    let w = capacity;

    while (w >= d) {
      if (dpTable[w - d] + v > dpTable[w]) {
        dpTable[w] = dpTable[w - d] + v;
        selectionTrace[i][w] = true;
      }
      w--;
    }

    i++;
  }

  return selectionTrace;
}

/**
 *  the selection trace is walked backwards to recover which tasks were chosen
 */
function reconstructChosenTasks(
  tasks: MaintenanceTask[],
  selectionTrace: boolean[][],
  capacity: number,
): MaintenanceTask[] {
  const chosen: MaintenanceTask[] = [];
  let remainingCapacity = capacity;
  let i = tasks.length - 1;

  while (i >= 0) {
    if (selectionTrace[i][remainingCapacity]) {
      chosen.push(tasks[i]);
      remainingCapacity -= tasks[i].Duration;
    }
    i--;
  }

  return chosen;
}

function computeOptimalSchedule(
  tasks: MaintenanceTask[],
  budgetHours: number,
): { assignedTasks: MaintenanceTask[]; totalImpact: number } {
  const valueTable = buildValueTable(tasks, budgetHours);
  const selectionTrace = buildSelectionTrace(tasks, budgetHours);
  const assignedTasks = reconstructChosenTasks(tasks, selectionTrace, budgetHours);

  return { assignedTasks, totalImpact: valueTable[budgetHours] };
}


// Data fetching


async function retrieveDepots(authToken: string): Promise<DepotRecord[]> {
  await Log('retrieveDepots', 'INFO', SERVICE_TAG, 'Requesting depot inventory from evaluation service');

  const response = await axios.get<{ depots: DepotRecord[] }>(
    `${EVALUATION_SERVER}/depots`,
    { headers: buildAuthHeader(authToken) },
  );

  const { depots } = response.data;
  await Log('retrieveDepots', 'INFO', SERVICE_TAG, `Depot inventory received: ${depots.length} depots`);
  return depots;
}

async function retrieveMaintenanceTasks(authToken: string): Promise<MaintenanceTask[]> {
  await Log('retrieveMaintenanceTasks', 'INFO', SERVICE_TAG, 'Requesting vehicle task list from evaluation service');

  const response = await axios.get<{ vehicles: MaintenanceTask[] }>(
    `${EVALUATION_SERVER}/vehicles`,
    { headers: buildAuthHeader(authToken) },
  );

  const tasks = response.data.vehicles;
  await Log('retrieveMaintenanceTasks', 'INFO', SERVICE_TAG, `Task list received: ${tasks.length} maintenance tasks`);
  return tasks;
}


// Output formatting


async function printScheduleSummary(schedules: DepotSchedule[]): Promise<void> {
  await Log('printScheduleSummary', 'INFO', SERVICE_TAG, '\n========== Vehicle Maintenance Schedule ==========\n');

  for (const schedule of schedules) {
    await Log('printScheduleSummary', 'INFO', SERVICE_TAG,
      `Depot ${schedule.depotID} (Budget: ${schedule.budgetHours}h) | Hours: ${schedule.consumedHours}/${schedule.budgetHours}h | Impact: ${schedule.totalImpactScore} | Tasks: ${schedule.assignedTasks.length}`
    );

    for (const task of schedule.assignedTasks) {
      await Log('printScheduleSummary', 'INFO', SERVICE_TAG,
        `  Task ${task.TaskID} — duration=${task.Duration}h  impact=${task.Impact}`
      );
    }
  }
}


// Entry point


async function run(): Promise<void> {
  const authToken = process.env.AUTH_TOKEN;
  if (!authToken) {
    await Log('run', 'ERROR', SERVICE_TAG, 'AUTH_TOKEN is not configured — cannot start scheduler');
    process.exit(1);
  }

  setAuthToken(authToken);
  await Log('run', 'INFO', SERVICE_TAG, 'Vehicle Maintenance Scheduler initialising');

  let depots: DepotRecord[];
  let tasks: MaintenanceTask[];

  try {
    [depots, tasks] = await Promise.all([
      retrieveDepots(authToken),
      retrieveMaintenanceTasks(authToken),
    ]);
  } catch (fetchError) {
    await Log('run', 'ERROR', SERVICE_TAG, `Data retrieval failed — cannot proceed: ${fetchError}`);
    process.exit(1);
  }

  const schedules: DepotSchedule[] = [];

  for (const depot of depots) {
    await Log(
      'run.optimiseDepot',
      'INFO',
      SERVICE_TAG,
      `Optimising depot ${depot.ID}: budget=${depot.MechanicHours}h, tasks=${tasks.length}`,
    );

    const { assignedTasks, totalImpact } = computeOptimalSchedule(tasks, depot.MechanicHours);
    const consumedHours = assignedTasks.reduce((sum, t) => sum + t.Duration, 0);

    schedules.push({
      depotID: depot.ID,
      budgetHours: depot.MechanicHours,
      assignedTasks,
      totalImpactScore: totalImpact,
      consumedHours,
    });

    await Log(
      'run.optimiseDepot',
      'INFO',
      SERVICE_TAG,
      `Depot ${depot.ID} scheduled: tasks=${assignedTasks.length}, impact=${totalImpact}, hours=${consumedHours}/${depot.MechanicHours}`,
    );
  }

  await printScheduleSummary(schedules);
  await Log('run', 'INFO', SERVICE_TAG, 'Scheduling complete');
}

run().catch(async (err) => {
  await Log('run', 'ERROR', SERVICE_TAG, `Unhandled exception: ${err}`);
  process.exit(1);
});
