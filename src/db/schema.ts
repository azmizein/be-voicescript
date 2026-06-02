// Types for the domain models — plain interfaces, no ORM dependency

export interface Reporter {
  id: number;
  name: string;
  city: string;
  is_available: number; // 0 | 1 (sql.js returns integers)
  rate_per_minute: number;
  created_at: string;
}

export interface Editor {
  id: number;
  name: string;
  flat_fee: number;
  created_at: string;
}

export type JobStatus = 'NEW' | 'ASSIGNED' | 'TRANSCRIBED' | 'REVIEWED' | 'COMPLETED';
export type LocationType = 'physical' | 'remote';

export interface Job {
  id: number;
  case_name: string;
  duration: number;
  location_type: LocationType;
  city: string | null;
  status: JobStatus;
  reporter_id: number | null;
  editor_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: number;
  job_id: number;
  reporter_payout: number;
  editor_payout: number;
  total_payout: number;
  rate_per_minute: number;
  calculated_at: string;
}
