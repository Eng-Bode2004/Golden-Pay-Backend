import CounterModel from "../Models/CounterSchema.ts";
import EmployeeRecordModel from "../Models/EmployeeRecordSchema.ts";
import UserModel from "../Models/UserSchema.ts";
import { env } from "../Config/env.ts";
import { ApiError } from "../Utils/http.ts";

const MAX_GENERATION_ATTEMPTS = 20;

/**
 * Generates an employee number such as GP-000123 using an atomic counter.
 * Existing HR records and users are checked as a safety net for manually
 * imported numbers.
 */
export async function generateEmployeeNumber(): Promise<string> {
  const counterKey = `employee_number:${env.employeeNumberPrefix}`;

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const counter = await CounterModel.findByIdAndUpdate(
      counterKey,
      { $inc: { value: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();

    if (!counter) continue;

    const serial = String(counter.value).padStart(env.employeeNumberPad, "0");
    const candidate = `${env.employeeNumberPrefix}-${serial}`;

    const [userExists, recordExists] = await Promise.all([
      UserModel.exists({ employee_number: candidate }),
      EmployeeRecordModel.exists({ employee_number: candidate }),
    ]);

    if (!userExists && !recordExists) return candidate;
  }

  throw new ApiError(
    500,
    "EMPLOYEE_NUMBER_GENERATION_FAILED",
    "Could not generate a unique employee number, please try again",
  );
}
