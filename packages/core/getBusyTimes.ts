import type { Credential } from "@prisma/client";

import { getBusyCalendarTimes } from "@calcom/core/CalendarManager";
import dayjs from "@calcom/dayjs";
import logger from "@calcom/lib/logger";
import { performance } from "@calcom/lib/server/perfObserver";
import prisma from "@calcom/prisma";
import type { SelectedCalendar } from "@calcom/prisma/client";
import { BookingStatus } from "@calcom/prisma/enums";
import type { EventBusyDetails } from "@calcom/types/Calendar";

export async function getBusyTimes(params: {
  credentials: Credential[];
  userId: number;
  username: string;
  eventTypeId?: number;
  startTime: string;
  beforeEventBuffer?: number;
  afterEventBuffer?: number;
  endTime: string;
  selectedCalendars: SelectedCalendar[];
  rescheduleUid?: string;
}) {
  const {
    credentials,
    userId,
    username,
    eventTypeId,
    startTime,
    endTime,
    beforeEventBuffer,
    afterEventBuffer,
    selectedCalendars,
    rescheduleUid
  } = params;
  logger.silly(
    `Checking Busy time from Cal Bookings in range ${startTime} to ${endTime} for input ${JSON.stringify({
      userId,
      eventTypeId,
      status: BookingStatus.ACCEPTED,
    })}`
  );
  // get user email for attendee checking.
  const user = await prisma.user.findUniqueOrThrow({
    where: {
      id: userId,
    },
    select: {
      email: true,
    },
  });

  /**
   * A user is considered busy within a given time period if there
   * is a booking they own OR attend.
   *
   * Performs a query for all bookings where:
   *   - The given booking is owned by this user, or..
   *   - The current user has a different booking at this time he/she attends
   *
   * See further discussion within this GH issue:
   * https://github.com/calcom/cal.com/issues/6374
   *
   * NOTE: Changes here will likely require changes to some mocking
   *  logic within getSchedule.test.ts:addBookings
   */
  performance.mark("prismaBookingGetStart");

  const sharedQuery = {
    startTime: { gte: new Date(startTime) },
    endTime: { lte: new Date(endTime) },
    status: {
      in: [BookingStatus.ACCEPTED],
    },
    // If the user is re-scheduling the meeting, then we need to make its nearest slots available.
    // For eg: If the user has previously selected 11:00 AM slot and now he wants to move it by 15 or 30 minutes earlier or later,
    // with the current implementation, those slots will not be shown because its overlapping with the already booked one,
    // so we need to ignore the current re-scheduling meetings slots and make the slots available accordingly
    ...(rescheduleUid ? {
      uid: {
        not: rescheduleUid
      }
    } : {})
  };

  // Find bookings that block this user from hosting further bookings.
  const busyTimes: EventBusyDetails[] = await prisma.booking
    .findMany({
      where: {
        OR: [
          // User is primary host (individual events, or primary organizer)
          {
            ...sharedQuery,
            userId,
          },
          // The current user has a different booking at this time he/she attends
          {
            ...sharedQuery,
            attendees: {
              some: {
                email: user.email,
              },
            },
          },
        ],
      },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        title: true,
        eventType: {
          select: {
            id: true,
            afterEventBuffer: true,
            beforeEventBuffer: true,
          },
        },
      },
    })
    .then((bookings) =>
      bookings.map(({ startTime, endTime, title, id, eventType }) => ({
        start: dayjs(startTime)
          .subtract((eventType?.beforeEventBuffer || 0) + (afterEventBuffer || 0), "minute")
          .toDate(),
        end: dayjs(endTime)
          .add((eventType?.afterEventBuffer || 0) + (beforeEventBuffer || 0), "minute")
          .toDate(),
        title,
        source: `eventType-${eventType?.id}-booking-${id}`,
      }))
    );
  logger.silly(`Busy Time from Cal Bookings ${JSON.stringify(busyTimes)}`);
  performance.mark("prismaBookingGetEnd");
  performance.measure(`prisma booking get took $1'`, "prismaBookingGetStart", "prismaBookingGetEnd");
  if (credentials?.length > 0) {
    const startConnectedCalendarsGet = performance.now();
    const calendarBusyTimes = await getBusyCalendarTimes(
      username,
      credentials,
      startTime,
      endTime,
      selectedCalendars
    );
    const endConnectedCalendarsGet = performance.now();
    logger.debug(
      `Connected Calendars get took ${
        endConnectedCalendarsGet - startConnectedCalendarsGet
      } ms for user ${username}`
    );
    busyTimes.push(
      ...calendarBusyTimes.map((value) => ({
        ...value,
        end: dayjs(value.end)
          .add(beforeEventBuffer || 0, "minute")
          .toDate(),
        start: dayjs(value.start)
          .subtract(afterEventBuffer || 0, "minute")
          .toDate(),
      }))
    );

    /*
    // TODO: Disabled until we can filter Zoom events by date. Also this is adding too much latency.
    const videoBusyTimes = (await getBusyVideoTimes(credentials)).filter(notEmpty);
    console.log("videoBusyTimes", videoBusyTimes);
    busyTimes.push(...videoBusyTimes);
    */
  }
  return busyTimes;
}

export default getBusyTimes;
