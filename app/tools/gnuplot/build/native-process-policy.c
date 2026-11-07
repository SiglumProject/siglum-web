#include <stdio.h>
#include <errno.h>
static unsigned denied_process_calls;
int __wrap_system(const char *command) {
    denied_process_calls++; errno = ENOSYS; return command ? -1 : 0;
}
FILE *__wrap_popen(const char *command, const char *mode) {
    (void)command; (void)mode; denied_process_calls++; errno = ENOSYS; return NULL;
}
int __wrap_pclose(FILE *stream) { (void)stream; errno = ENOSYS; return -1; }
unsigned siglum_gnuplot_denied_system_calls(void) { return denied_process_calls; }
