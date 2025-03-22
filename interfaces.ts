interface air_quality {
    device_id: number;
    pm25: number;
    pm10: number;
    temperature: number;
    humidity: number;
    recorded_at: Date;
    isOutside: number;
    deviceInRoom: number;
}